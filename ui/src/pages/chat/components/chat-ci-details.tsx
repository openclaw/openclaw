import { For, Show, createEffect, createSignal, onSettled } from "solid-js";
import type {
  ControlUiSessionPullRequestCheck,
  ControlUiSessionPullRequestCheckDetails,
  ControlUiSessionPullRequestCheckStep,
} from "../../../../../src/gateway/control-ui-contract.js";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatCiEnglish } from "../../../i18n/locales/en-chat-ci.ts";
import { registerGitHubEnglish } from "../../../i18n/locales/en-github.ts";
import { formatDurationCompact } from "../../../lib/format-duration.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../../lib/gateway-connection-lifecycle.ts";
import { resolveSafeExternalUrl } from "../../../lib/open-external-url.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import { ChatCiDisclosure, type ChatCiDisclosureProps } from "./chat-ci-disclosure.ts";

registerEnglishCatalog(registerChatCiEnglish);
registerEnglishCatalog(registerGitHubEnglish);

const REFRESH_MS = 30_000;
const CHECK_ORDER = { failed: 0, running: 1, passed: 2, skipped: 3 } as const;
type CheckState = ControlUiSessionPullRequestCheck["state"] | "queued";

const STEP_CONCLUSIONS = new Map<string, CheckState>([
  ["success", "passed"],
  ["failure", "failed"],
  ["timed_out", "failed"],
  ["action_required", "failed"],
  ["startup_failure", "failed"],
  ["skipped", "skipped"],
  ["neutral", "skipped"],
  ["cancelled", "skipped"],
]);

function stepState(step: ControlUiSessionPullRequestCheckStep): CheckState {
  if (step.status === "in_progress") {
    return "running";
  }
  return STEP_CONCLUSIONS.get(step.conclusion ?? "") ?? "queued";
}

const CHECK_PRESENTATION = {
  passed: ["chat.pullRequests.checksPassed", "check"],
  failed: ["chat.pullRequests.checksFailed", "circleX"],
  running: ["chat.pullRequests.checksRunning", "loader"],
  skipped: ["chat.pullRequests.checksSkipped", "clock"],
  queued: ["chat.pullRequests.checksQueued", "clock"],
} as const;

function CheckStatus(props: { state: CheckState }) {
  const label = () => t(CHECK_PRESENTATION[props.state][0]);
  return (
    <span
      class="chat-ci__status"
      data-state={props.state}
      role="img"
      aria-label={label()}
      title={label()}
    >
      <Show
        when={props.state !== "skipped"}
        fallback={
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M8 12h8" />
          </svg>
        }
      >
        <Icon name={CHECK_PRESENTATION[props.state][1]} />
      </Show>
    </span>
  );
}

function duration(item: { startedAt?: string; completedAt?: string }, running: boolean): string {
  const start = item.startedAt ? Date.parse(item.startedAt) : Number.NaN;
  const end = item.completedAt ? Date.parse(item.completedAt) : running ? Date.now() : Number.NaN;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? (formatDurationCompact(end - start) ?? "")
    : "";
}

/** Presentation-only details: the Gateway owns GitHub discovery, joins, and caching. */
class ChatCiDetailsController extends ChatCiDisclosure {
  loading = false;
  result?: ControlUiSessionPullRequestCheckDetails;
  error: string | null = null;

  private stopGateway?: () => void;
  private boundGateway?: ApplicationGateway;
  private readonly connection = createGatewayConnectionLifecycle({
    client: null,
    phase: "stopped",
  });
  private target = "";
  private requestGeneration = 0;
  private requestController?: AbortController;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  retryAt = 0;
  readonly expandedJobs = new Map<number, boolean>();
  private expansionInitialized = false;

  protected override disconnect(): void {
    this.stopGateway?.();
    this.stopGateway = undefined;
    this.boundGateway = undefined;
    this.connection.transition({ client: null, phase: "stopped" });
    this.reset();
  }

  private targetKey(): string {
    const pr = this.pullRequest;
    return JSON.stringify([this.sessionKey, pr?.owner, pr?.repo, pr?.number, pr?.headSha]);
  }

  protected override syncProps(changed: ReadonlyMap<string, unknown>): void {
    const target = this.targetKey();
    if (target !== this.target) {
      // Head changes refresh the same open monitor; session changes dismiss it.
      if (changed.has("sessionKey") && changed.get("sessionKey") && this.disclosure) {
        this.disclosure.open = false;
      }
      this.target = target;
      this.reset();
    }
    if (this.boundGateway !== this.gateway) {
      this.stopGateway?.();
      this.boundGateway = this.gateway;
      this.connection.transition(this.gateway?.snapshot ?? { client: null, phase: "stopped" });
      this.reset();
      this.stopGateway = this.gateway?.subscribe((snapshot) => {
        if (this.connection.transition(snapshot)) {
          this.reset();
          void this.load();
        }
      });
    }
    if (!this.visible) {
      this.cancelRequest();
    }
  }

  protected override refreshIfVisible(changed: ReadonlyMap<string, unknown>): void {
    if (
      changed.has("pullRequest") ||
      changed.has("gateway") ||
      changed.has("sessionKey") ||
      changed.has("presented")
    ) {
      if (
        this.visible &&
        !this.loading &&
        (changed.has("presented") || (!this.result && !this.error))
      ) {
        void this.load();
      }
    }
  }

  private cancelRequest(): void {
    this.requestGeneration += 1;
    this.requestController?.abort();
    this.requestController = undefined;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.loading = false;
  }

  private reset(): void {
    this.cancelRequest();
    this.result = undefined;
    this.error = null;
    this.retryAt = 0;
    this.expandedJobs.clear();
    this.expansionInitialized = false;
  }

  protected override readonly handleVisibility = (): void => {
    if (this.visible) {
      void this.load();
    } else {
      this.cancelRequest();
    }
  };

  async load(): Promise<void> {
    if (!this.visible || this.loading) {
      return;
    }
    if (Date.now() < this.retryAt) {
      this.scheduleRetryAvailability();
      return;
    }
    const pr = this.pullRequest;
    const gateway = this.gateway;
    const scope = this.connection.capture();
    if (!scope || !gateway || !pr?.headSha || !this.sessionKey) {
      this.error = t("chat.pullRequests.checksUnavailable");
      this.publish();
      return;
    }
    clearTimeout(this.refreshTimer);
    const generation = ++this.requestGeneration;
    const target = this.targetKey();
    const connectionGeneration = scope.client.connectionGeneration;
    const connectionRevision = gateway.connectionRevision;
    const controller = new AbortController();
    this.requestController = controller;
    this.loading = true;
    this.error = null;
    this.publish();
    const current = () =>
      this.visible &&
      generation === this.requestGeneration &&
      target === this.targetKey() &&
      gateway === this.gateway &&
      gateway.connectionRevision === connectionRevision &&
      gateway.snapshot.client === scope.client &&
      gateway.snapshot.phase === "connected" &&
      this.connection.isCurrent(scope) &&
      scope.client.connectionGeneration === connectionGeneration;
    try {
      const result = await scope.client.request<ControlUiSessionPullRequestCheckDetails>(
        "controlUi.sessionPullRequests.checks",
        {
          sessionKey: this.sessionKey,
          owner: pr.owner,
          repo: pr.repo,
          number: pr.number,
          headSha: pr.headSha,
        },
        { signal: controller.signal },
      );
      if (!current()) {
        return;
      }
      if (
        result.owner.toLowerCase() !== pr.owner.toLowerCase() ||
        result.repo.toLowerCase() !== pr.repo.toLowerCase() ||
        result.number !== pr.number ||
        result.headSha !== pr.headSha
      ) {
        this.result = undefined;
        this.error = t("chat.pullRequests.checksUnavailable");
        return;
      }
      this.result = result;
      this.retryAt =
        Date.now() + Math.max(0, result.retryAfterMs ?? (result.rateLimited ? 60_000 : 0));
      if (!this.expansionInitialized && result.checks.length > 0) {
        this.expansionInitialized = true;
        const first = result.checks
          .toSorted((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state])
          .find((check) => check.state === "failed" || check.state === "running");
        if (first) {
          this.expandedJobs.set(first.id, true);
        }
      }
      const ids = new Set(result.checks.map((check) => check.id));
      for (const id of this.expandedJobs.keys()) {
        if (!ids.has(id)) {
          this.expandedJobs.delete(id);
        }
      }
      if (this.retryAt > Date.now()) {
        this.scheduleRetryAvailability();
      } else if (result.status === "ready") {
        // Completed jobs can be rerun on the same head without changing the
        // summary counts. Poll only the visible monitor, even after completion.
        this.refreshTimer = setTimeout(() => void this.load(), REFRESH_MS);
      }
    } catch (error) {
      if (current()) {
        // Only explicit stale responses authorize retaining previous details.
        this.result = undefined;
        this.error = formatUiError(error, t("chat.pullRequests.checksUnavailable"));
      }
    } finally {
      if (current()) {
        this.loading = false;
        this.requestController = undefined;
        this.publish();
      }
    }
  }

  private scheduleRetryAvailability(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(
      () => this.publish(),
      Math.min(2_147_483_647, Math.max(0, this.retryAt - Date.now())),
    );
  }
}

export type ChatCiDetailsElement = SolidBridgeElement<ChatCiDisclosureProps>;
function ChatCiDetailsContent(
  props: ChatCiDisclosureProps,
  host: SolidBridgeElement<ChatCiDisclosureProps>,
) {
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const notify = () => setRevision((value) => value + 1);
  const model = new ChatCiDetailsController(host, host, notify);
  const read = () => {
    revision();
    return model;
  };
  createEffect(
    () => [props.gateway, props.pullRequest, props.sessionKey, props.presented],
    () => model.sync(),
  );
  onSettled(() => {
    model.connect();
    return () => model.dispose();
  });
  const retryWait = () => Math.max(0, read().retryAt - Date.now());
  const result = () => read().result;
  const checks = () => result()?.checks ?? [];
  const jobs = () =>
    checks()
      .filter((check) => check.state !== "skipped")
      .toSorted((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state]);
  const skipped = () => checks().filter((check) => check.state === "skipped");
  const showNotice = () =>
    result()?.rateLimited ||
    result()?.status === "stale" ||
    read().error ||
    result()?.status === "unavailable" ||
    result()?.error;
  const job = (check: () => ControlUiSessionPullRequestCheck) => {
    const jobState = (): CheckState =>
      check().state === "running" && check().status !== "in_progress" ? "queued" : check().state;
    const url = () =>
      check().detailsUrl
        ? resolveSafeExternalUrl(check().detailsUrl!, host.ownerDocument.baseURI)
        : null;
    return (
      <details
        class="chat-ci__job"
        data-state={check().state}
        data-check-id={check().id}
        prop:open={read().expandedJobs.get(check().id) ?? false}
        onToggle={(event) => {
          if (event.target !== event.currentTarget) {
            return;
          }
          model.expandedJobs.set(check().id, event.currentTarget.open);
          notify();
        }}
      >
        <summary class="chat-ci__job-summary">
          <CheckStatus state={jobState()} />
          <span class="chat-ci__name">{check().name}</span>
          <span class="chat-ci__duration">{duration(check(), jobState() === "running")}</span>
          <span class="chat-ci__chevron" aria-hidden="true">
            <Icon name="chevronDown" />
          </span>
        </summary>
        <div class="chat-ci__job-detail">
          <Show
            when={check().steps?.length}
            fallback={
              <div class="chat-ci__empty-steps">
                {t(
                  check().source === "check"
                    ? "chat.pullRequests.checksNoSteps"
                    : "chat.pullRequests.checksStepsUnavailable",
                )}
              </div>
            }
          >
            <ol class="chat-ci__steps" role="list">
              <For
                each={check().steps?.toSorted((a, b) => a.number - b.number)}
                keyed={(step) => step.number}
              >
                {(step) => (
                  <li class="chat-ci__step" data-state={stepState(step())} value={step().number}>
                    <CheckStatus state={stepState(step())} />
                    <span class="chat-ci__name">{step().name}</span>
                    <span class="chat-ci__duration">
                      {duration(step(), stepState(step()) === "running")}
                    </span>
                  </li>
                )}
              </For>
            </ol>
          </Show>
          <Show when={url()}>
            {(href) => (
              <a class="chat-ci__job-link" href={href()} target="_blank" rel="noopener noreferrer">
                {t(
                  check().source === "actions"
                    ? "chat.pullRequests.openJob"
                    : "chat.pullRequests.openCheck",
                )}
                <Icon name="externalLink" />
              </a>
            )}
          </Show>
        </div>
      </details>
    );
  };
  return (
    <>
      <Show
        when={read().loading && !result()}
        fallback={
          <Show when={showNotice()}>
            <div
              class="chat-ci__notice"
              role="status"
              data-state={result()?.rateLimited ? "rate-limited" : "unavailable"}
            >
              <span>
                {read().error ??
                  t(
                    result()?.rateLimited
                      ? "chat.pullRequests.checksRateLimited"
                      : result()?.status === "stale"
                        ? "chat.pullRequests.checksStale"
                        : "chat.pullRequests.checksUnavailable",
                  )}
                {retryWait() > 0
                  ? t("chat.pullRequests.checksRetryAfter", {
                      duration: formatDurationCompact(retryWait()) ?? "",
                    })
                  : undefined}
              </span>
              <button
                class="chat-ci__retry"
                type="button"
                disabled={read().loading || retryWait() > 0}
                onClick={() => {
                  void model.load();
                }}
              >
                {t("common.retry")}
              </button>
            </div>
          </Show>
        }
      >
        <div class="chat-ci__notice" role="status">
          {t("chat.pullRequests.checksLoading")}
        </div>
      </Show>
      <div class="chat-ci__jobs" aria-busy={read().loading ? "true" : "false"}>
        <For each={jobs()} keyed={(check) => check.id}>
          {job}
        </For>
        <Show when={skipped().length}>
          <details class="chat-ci__skipped">
            <summary>
              <CheckStatus state="skipped" />
              <span>
                {t("chat.pullRequests.checksSkippedCount", { count: String(skipped().length) })}
              </span>
              <span class="chat-ci__chevron" aria-hidden="true">
                <Icon name="chevronDown" />
              </span>
            </summary>
            <For each={skipped()} keyed={(check) => check.id}>
              {job}
            </For>
          </details>
        </Show>
        <Show
          when={
            result()?.status === "ready" &&
            !checks().length &&
            !result()?.rateLimited &&
            !result()?.error
          }
        >
          <div class="chat-ci__notice">{t("chat.pullRequests.checksEmpty")}</div>
        </Show>
      </div>
    </>
  );
}

export const ChatCiDetails = defineSolidBridge<ChatCiDisclosureProps>(
  "openclaw-chat-ci-details",
  ChatCiDetailsContent,
  {
    properties: {
      gateway: { default: undefined, attribute: false },
      pullRequest: { default: undefined, attribute: false },
      sessionKey: { default: "", attribute: false },
      presented: { default: true, type: Boolean },
    },
  },
);
