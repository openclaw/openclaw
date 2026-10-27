import {
  Errored,
  For,
  Loading,
  Show,
  createMemo,
  createSignal,
  createStore,
  isPending,
  latest,
} from "solid-js";
import type {
  ControlUiSessionPullRequestCheck,
  ControlUiSessionPullRequestCheckDetails,
  ControlUiSessionPullRequestCheckStep,
} from "../../../../../src/gateway/control-ui-contract.js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuControls } from "../../../components/solid/menu.tsx";
import { StrokeIcon } from "../../../components/solid/stroke-icon.tsx";
import { registerChatCiEnglish } from "../../../i18n/locales/en-chat-ci.ts";
import { registerGitHubEnglish } from "../../../i18n/locales/en-github.ts";
import { formatDurationCompact } from "../../../lib/format-duration.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../../lib/gateway-connection-lifecycle.ts";
import { resolveSafeExternalUrl } from "../../../lib/open-external-url.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { createCiDisclosure, type ChatCiDisclosureProps } from "./chat-ci-disclosure.ts";
import { subscribeCiGatewayUpdates } from "./chat-ci-gateway-updates.ts";

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
          <StrokeIcon aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M8 12h8" />
          </StrokeIcon>
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
type DetailsState = {
  retryAt: number;
  expandedJobs: Record<number, boolean>;
};
const inputHandlers = new WeakMap<HTMLElement, (key: keyof ChatCiDetailsProps) => void>();

type ChatCiDetailsProps = ChatCiDisclosureProps & {
  /** Opt summaries into the containing Menu's native control navigation. */
  menuControls?: boolean;
  controls?: MenuControls;
};

export type ChatCiDetailsElement = SolidBridgeElement<ChatCiDetailsProps>;

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-ci-details": ChatCiDetailsElement;
  }
}

function ChatCiDetailsContent(props: ChatCiDetailsProps, host: ChatCiDetailsElement) {
  const [state, setState] = createStore<DetailsState>({
    retryAt: 0,
    expandedJobs: {},
  });
  const connection = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });
  const [receipt, setReceipt] = createSignal(
    Promise.resolve<ControlUiSessionPullRequestCheckDetails | undefined>(undefined),
  );
  const read = createMemo(() => receipt());
  const [scopeRevision, setScope] = createSignal(0);
  let accepted: ControlUiSessionPullRequestCheckDetails | undefined;
  let target = "";
  let sessionKey = "";
  let stopGateway: (() => void) | undefined;
  let requestController: AbortController | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let expansionInitialized = false;
  const disclosure = createCiDisclosure(host, handleVisibility, () => {
    inputHandlers.set(host, handleInputsChanged);
    bindGateway();
    syncTarget();
    return () => {
      inputHandlers.delete(host);
      stopGateway?.();
      connection.dispose();
      requestController?.abort();
      clearTimeout(refreshTimer);
    };
  });

  function bindGateway() {
    stopGateway?.();
    const gateway = host.gateway;
    connection.transition(gateway?.snapshot ?? { client: null, phase: "stopped" });
    reset();
    // Revoke in-flight request scopes on every connection edge, before later acknowledgments.
    stopGateway = gateway
      ? subscribeCiGatewayUpdates(gateway, "details", (snapshot) => {
          if (connection.transition(snapshot)) {
            reset();
            queueMicrotask(load);
          }
        })
      : undefined;
    queueMicrotask(load);
  }

  function syncTarget() {
    const next = JSON.stringify([
      host.sessionKey,
      host.pullRequest?.owner,
      host.pullRequest?.repo,
      host.pullRequest?.number,
      host.pullRequest?.headSha,
    ]);
    if (target === next) {
      return false;
    }
    // Head changes refresh the same open monitor; session changes dismiss it.
    if (sessionKey && sessionKey !== host.sessionKey) {
      disclosure.close();
    }
    target = next;
    sessionKey = host.sessionKey;
    reset();
    return true;
  }

  function handleInputsChanged(key: keyof ChatCiDetailsProps) {
    if (key === "gateway") {
      bindGateway();
    } else if (key === "presented" || key === "inline" || syncTarget()) {
      if (!disclosure.visible()) {
        cancelRequest();
      } else {
        queueMicrotask(handleVisibility);
      }
    }
  }

  function cancelRequest() {
    requestController?.abort();
    requestController = undefined;
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
    void setReceipt(Promise.resolve(accepted));
  }

  function reset() {
    cancelRequest();
    accepted = undefined;
    void setReceipt(Promise.resolve(undefined));
    setScope((value) => value + 1);
    setState((draft) => {
      draft.retryAt = 0;
      draft.expandedJobs = {};
    });
    expansionInitialized = false;
  }

  function handleVisibility() {
    if (disclosure.visible()) {
      load();
    } else {
      cancelRequest();
    }
  }

  function load(): void {
    if (!disclosure.visible() || requestController) {
      return;
    }
    if (Date.now() < state.retryAt) {
      scheduleRetryAvailability(state.retryAt);
      return;
    }
    const pr = host.pullRequest;
    const scope = connection.capture();
    if (!scope || !host.gateway || !pr?.headSha || !host.sessionKey) {
      const result = Promise.reject(new Error(t("chat.pullRequests.checksUnavailable")));
      void setReceipt(result);
      void result.catch(() => {});
      return;
    }
    clearTimeout(refreshTimer);
    const controller = new AbortController();
    const client = scope.client;
    const params = {
      sessionKey: host.sessionKey,
      owner: pr.owner,
      repo: pr.repo,
      number: pr.number,
      headSha: pr.headSha,
    };
    requestController = controller;
    const current = () =>
      disclosure.visible() && requestController === controller && connection.isCurrent(scope);
    const pending = request();
    void setReceipt(pending);
    // The read boundary observes failures even if this disclosure closes first.
    void pending.catch(() => {});

    async function request(): Promise<ControlUiSessionPullRequestCheckDetails | undefined> {
      try {
        const result = await client.request<ControlUiSessionPullRequestCheckDetails>(
          "controlUi.sessionPullRequests.checks",
          params,
          { signal: controller.signal },
        );
        if (!current()) {
          return accepted;
        }
        accepted = result;
        const retryAt =
          Date.now() + Math.max(0, result.retryAfterMs ?? (result.rateLimited ? 60_000 : 0));
        setState((draft) => {
          draft.retryAt = retryAt;
          if (!expansionInitialized && result.checks.length > 0) {
            expansionInitialized = true;
            const first = result.checks
              .toSorted((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state])
              .find((check) => check.state === "failed" || check.state === "running");
            if (first) {
              draft.expandedJobs[first.id] = true;
            }
          }
          const ids = new Set(result.checks.map((check) => check.id));
          for (const id of Object.keys(draft.expandedJobs)) {
            if (!ids.has(Number(id))) {
              delete draft.expandedJobs[Number(id)];
            }
          }
        });
        if (retryAt > Date.now()) {
          scheduleRetryAvailability(retryAt);
        } else if (result.status === "ready") {
          // Completed jobs can be rerun on the same head without changing the summary counts.
          refreshTimer = setTimeout(load, REFRESH_MS);
        }
        return result;
      } catch (error) {
        if (current()) {
          // Only explicit stale responses authorize retaining previous details.
          accepted = undefined;
          throw new Error(formatUiError(error, t("chat.pullRequests.checksUnavailable")), {
            cause: error,
          });
        }
        return accepted;
      } finally {
        if (current()) {
          requestController = undefined;
        }
      }
    }
  }

  function scheduleRetryAvailability(retryAt: number) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(
      () => {
        setState((draft) => {
          draft.retryAt = 0;
        });
      },
      Math.min(2_147_483_647, Math.max(0, retryAt - Date.now())),
    );
  }
  const retryWait = () => Math.max(0, state.retryAt - Date.now());
  const result = createMemo(() => latest(read));
  const loading = createMemo(() => isPending(read));
  const checks = () => result()?.checks ?? [];
  const jobs = () =>
    checks()
      .filter((check) => check.state !== "skipped")
      .toSorted((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state]);
  const skipped = () => checks().filter((check) => check.state === "skipped");
  const showNotice = () =>
    result()?.rateLimited ||
    result()?.status === "stale" ||
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
        prop:open={state.expandedJobs[check().id] ?? false}
        onToggle={(event) => {
          if (event.target !== event.currentTarget) {
            return;
          }
          const id = check().id;
          const open = event.currentTarget.open;
          setState((draft) => {
            draft.expandedJobs[id] = open;
          });
        }}
      >
        <Show when={{ ref: props.controls?.ref() }} keyed>
          {(binding) => (
            <summary
              ref={binding.ref}
              class="chat-ci__job-summary"
              data-form-control={props.menuControls ? "" : undefined}
            >
              <CheckStatus state={jobState()} />
              <span class="chat-ci__name">{check().name}</span>
              <span class="chat-ci__duration">{duration(check(), jobState() === "running")}</span>
              <span class="chat-ci__chevron" aria-hidden="true">
                <Icon name="chevronDown" />
              </span>
            </summary>
          )}
        </Show>
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
              <Show when={{ ref: props.controls?.ref() }} keyed>
                {(binding) => (
                  <a
                    ref={binding.ref}
                    class="chat-ci__job-link"
                    href={href()}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t(
                      check().source === "actions"
                        ? "chat.pullRequests.openJob"
                        : "chat.pullRequests.openCheck",
                    )}
                    <Icon name="externalLink" />
                  </a>
                )}
              </Show>
            )}
          </Show>
        </div>
      </details>
    );
  };
  const notice = (error: () => string | undefined, retry: () => void) => (
    <div
      class="chat-ci__notice"
      role="status"
      data-state={!error() && result()?.rateLimited ? "rate-limited" : "unavailable"}
    >
      <span>
        {error() ??
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
      <Show when={{ ref: props.controls?.ref() }} keyed>
        {(binding) => (
          <button
            ref={binding.ref}
            class="chat-ci__retry"
            type="button"
            disabled={loading() || retryWait() > 0}
            onClick={() => retry()}
          >
            {t("common.retry")}
          </button>
        )}
      </Show>
    </div>
  );
  const loadingNotice = () => (
    <div class="chat-ci__notice" role="status">
      {t("chat.pullRequests.checksLoading")}
    </div>
  );
  return (
    <Errored
      fallback={(error, resetError) => (
        <>
          {notice(
            () => formatUiError(error()),
            () => {
              load();
              resetError();
            },
          )}
          <div class="chat-ci__jobs" aria-busy="false" />
        </>
      )}
    >
      <Loading
        on={scopeRevision()}
        fallback={
          <>
            {loadingNotice()}
            <div class="chat-ci__jobs" aria-busy="true" />
          </>
        }
      >
        <Show
          when={loading() && !result()}
          fallback={<Show when={showNotice()}>{notice(() => undefined, load)}</Show>}
        >
          {loadingNotice()}
        </Show>
        <div class="chat-ci__jobs" aria-busy={loading() ? "true" : "false"}>
          <For each={jobs()} keyed={(check) => check.id}>
            {job}
          </For>
          <Show when={skipped().length}>
            <details class="chat-ci__skipped">
              <Show when={{ ref: props.controls?.ref() }} keyed>
                {(binding) => (
                  <summary
                    ref={binding.ref}
                    data-form-control={props.menuControls ? "" : undefined}
                  >
                    <CheckStatus state="skipped" />
                    <span>
                      {t("chat.pullRequests.checksSkippedCount", {
                        count: String(skipped().length),
                      })}
                    </span>
                    <span class="chat-ci__chevron" aria-hidden="true">
                      <Icon name="chevronDown" />
                    </span>
                  </summary>
                )}
              </Show>
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
      </Loading>
    </Errored>
  );
}

export const ChatCiDetails = defineSolidBridge<ChatCiDetailsProps>(
  "openclaw-chat-ci-details",
  ChatCiDetailsContent,
  {
    propertyChanged: (host, key) => inputHandlers.get(host)?.(key),
    properties: {
      gateway: { default: undefined, attribute: false },
      pullRequest: { default: undefined, attribute: false },
      sessionKey: { default: "", attribute: false },
      presented: { default: true, type: Boolean },
      inline: { default: false, attribute: false },
      menuControls: { default: false, attribute: false },
      controls: { default: undefined, attribute: false },
    },
  },
);
