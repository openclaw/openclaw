import { For, Show, createEffect, createMemo, createStore } from "solid-js";
import type {
  ControlUiSessionPullRequestCheck,
  ControlUiSessionPullRequestCheckDetails,
  ControlUiSessionPullRequestCheckStep,
} from "../../../../../src/gateway/control-ui-contract.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatCiEnglish } from "../../../i18n/locales/en-chat-ci.ts";
import { registerGitHubEnglish } from "../../../i18n/locales/en-github.ts";
import { formatDurationCompact } from "../../../lib/format-duration.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../../lib/gateway-connection-lifecycle.ts";
import { resolveSafeExternalUrl } from "../../../lib/open-external-url.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { createCiDisclosure, type ChatCiDisclosureProps } from "./chat-ci-disclosure.ts";

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
type DetailsState = {
  loading: boolean;
  result: ControlUiSessionPullRequestCheckDetails | undefined;
  error: string | null;
  retryAt: number;
  expandedJobs: Record<number, boolean>;
};

function createCiDetails(
  props: ChatCiDisclosureProps,
  host: SolidBridgeElement<ChatCiDisclosureProps>,
) {
  const [state, setState] = createStore<DetailsState>({
    loading: false,
    result: undefined,
    error: null,
    retryAt: 0,
    expandedJobs: {},
  });
  const connection = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });
  let target = "";
  let requestController: AbortController | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let expansionInitialized = false;
  const disclosure = createCiDisclosure(host, handleVisibility, () => {
    connection.dispose();
    requestController?.abort();
    clearTimeout(refreshTimer);
  });

  // Rebind Gateway connection notifications and retire requests from the old client.
  createEffect(
    () => props.gateway,
    (gateway) => {
      connection.transition(gateway?.snapshot ?? { client: null, phase: "stopped" });
      reset();
      // Revoke in-flight request scopes on every connection edge, before later acknowledgments.
      const stop = gateway?.subscribe((snapshot) => {
        if (connection.transition(snapshot)) {
          reset();
          queueMicrotask(() => void load());
        }
      });
      queueMicrotask(() => void load());
      return stop;
    },
  );
  const targetKey = createMemo(() =>
    JSON.stringify([
      props.sessionKey,
      props.pullRequest?.owner,
      props.pullRequest?.repo,
      props.pullRequest?.number,
      props.pullRequest?.headSha,
    ]),
  );
  // Session and visibility changes control the external checks request and disclosure.
  createEffect(
    () => [props.sessionKey, targetKey(), props.presented] as const,
    ([sessionKey, nextTarget], previous) => {
      if (target !== nextTarget) {
        // Head changes refresh the same open monitor; session changes dismiss it.
        if (previous?.[0] && previous[0] !== sessionKey) {
          disclosure.close();
        }
        target = nextTarget;
        reset();
      }
      if (!disclosure.visible()) {
        cancelRequest();
      } else {
        queueMicrotask(handleVisibility);
      }
    },
  );

  function cancelRequest() {
    requestController?.abort();
    requestController = undefined;
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
    setState((draft) => {
      draft.loading = false;
    });
  }

  function reset() {
    cancelRequest();
    setState((draft) => {
      draft.result = undefined;
      draft.error = null;
      draft.retryAt = 0;
      draft.expandedJobs = {};
    });
    expansionInitialized = false;
  }

  function handleVisibility() {
    if (disclosure.visible()) {
      void load();
    } else {
      cancelRequest();
    }
  }

  async function load(): Promise<void> {
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
      setState((draft) => {
        draft.error = t("chat.pullRequests.checksUnavailable");
      });
      return;
    }
    clearTimeout(refreshTimer);
    const controller = new AbortController();
    requestController = controller;
    setState((draft) => {
      draft.loading = true;
      draft.error = null;
    });
    const current = () =>
      disclosure.visible() && requestController === controller && connection.isCurrent(scope);
    try {
      const result = await scope.client.request<ControlUiSessionPullRequestCheckDetails>(
        "controlUi.sessionPullRequests.checks",
        {
          sessionKey: host.sessionKey,
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
      const retryAt =
        Date.now() + Math.max(0, result.retryAfterMs ?? (result.rateLimited ? 60_000 : 0));
      setState((draft) => {
        draft.result = result;
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
        refreshTimer = setTimeout(() => void load(), REFRESH_MS);
      }
    } catch (error) {
      if (current()) {
        // Only explicit stale responses authorize retaining previous details.
        setState((draft) => {
          draft.result = undefined;
          draft.error = formatUiError(error, t("chat.pullRequests.checksUnavailable"));
        });
      }
    } finally {
      if (current()) {
        requestController = undefined;
        setState((draft) => {
          draft.loading = false;
        });
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
  return {
    state,
    load,
    setExpanded: (id: number, open: boolean) => {
      setState((draft) => {
        draft.expandedJobs[id] = open;
      });
    },
  };
}

export type ChatCiDetailsElement = SolidBridgeElement<ChatCiDisclosureProps>;
function ChatCiDetailsContent(
  props: ChatCiDisclosureProps,
  host: SolidBridgeElement<ChatCiDisclosureProps>,
) {
  const model = createCiDetails(props, host);
  const state = model.state;
  const retryWait = () => Math.max(0, state.retryAt - Date.now());
  const result = () => state.result;
  const checks = () => result()?.checks ?? [];
  const jobs = () =>
    checks()
      .filter((check) => check.state !== "skipped")
      .toSorted((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state]);
  const skipped = () => checks().filter((check) => check.state === "skipped");
  const showNotice = () =>
    result()?.rateLimited ||
    result()?.status === "stale" ||
    state.error ||
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
          model.setExpanded(check().id, event.currentTarget.open);
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
        when={state.loading && !result()}
        fallback={
          <Show when={showNotice()}>
            <div
              class="chat-ci__notice"
              role="status"
              data-state={result()?.rateLimited ? "rate-limited" : "unavailable"}
            >
              <span>
                {state.error ??
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
                disabled={state.loading || retryWait() > 0}
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
      <div class="chat-ci__jobs" aria-busy={state.loading ? "true" : "false"}>
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

defineSolidBridge<ChatCiDisclosureProps>("openclaw-chat-ci-details", ChatCiDetailsContent, {
  properties: {
    gateway: { default: undefined, attribute: false },
    pullRequest: { default: undefined, attribute: false },
    sessionKey: { default: "", attribute: false },
    presented: { default: true, type: Boolean },
  },
});
