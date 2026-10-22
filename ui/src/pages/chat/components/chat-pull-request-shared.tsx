import { For, Show } from "solid-js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../../../src/gateway/control-ui-contract.js";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/tooltip.ts";
import { registerGitHubEnglish } from "../../../i18n/locales/en-github.ts";
import type { PresentationValue } from "../../../lib/presentation.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-owner.ts";
registerGitHubEnglish();

export type ChatPullRequestsProps = {
  pullRequests: ControlUiSessionPullRequest[];
  gateway?: ApplicationGateway;
  sessionKey?: string;
  sessionId?: string;
  presented?: PresentationValue;
  dismissed?: boolean;
  branch?: ControlUiSessionBranch;
  /** Hides the branch row and its idle publish offer; retained publication outcomes stay visible. */
  branchDismissed?: boolean;
  status: ControlUiSessionPullRequestSnapshot["status"];
  onDismiss: (pullRequest: ControlUiSessionPullRequest) => void;
  onDismissBranch?: (branch: ControlUiSessionBranch) => void;
  onOpenSessionDiff?: () => void;
  publication?: GitHubPublicationView;
  /** Compact row in the user-opened Details surface; actions keep their owners. */
  compact?: boolean;
  /** Keep publication work in Environment; only completed receipts and PRs belong here. */
  publishedOnly?: boolean;
};
export const STATE_LABEL_KEYS = {
  merged: "chat.pullRequests.merged",
  draft: "chat.pullRequests.draft",
  closed: "chat.pullRequests.closed",
  open: "chat.pullRequests.open",
} as const;
const CHECK_ROW_LABELS = {
  failed: "chat.pullRequests.checksFailed",
  passed: "chat.pullRequests.checksPassed",
  running: "chat.pullRequests.checksRunning",
  skipped: "chat.pullRequests.checksSkipped",
} as const;

export function ChecksRows(props: {
  checks: ControlUiSessionPullRequest["checks"];
  runningFirst?: boolean;
}) {
  const order = () =>
    props.runningFirst
      ? (["failed", "running", "passed", "skipped"] as const)
      : (["failed", "passed", "running", "skipped"] as const);
  return (
    <For each={order()}>
      {(kind) => (
        <Show when={(props.checks?.[kind] ?? 0) !== 0}>
          <div class={["chat-pr__checks-row", `chat-pr__checks-row--${kind}`]}>
            <span class="chat-pr__check-symbol" aria-hidden="true">
              <Show when={kind !== "running"} fallback={<span class="btn__spinner" />}>
                <Icon name={kind === "failed" ? "x" : kind === "passed" ? "check" : "circle"} />
              </Show>
            </span>
            <span class="chat-pr__checks-row-label">{t(CHECK_ROW_LABELS[kind])}</span>
            <span class="chat-pr__checks-row-count">{props.checks?.[kind] ?? 0}</span>
          </div>
        </Show>
      )}
    </For>
  );
}

export function StatusWarning(props: {
  status: ControlUiSessionPullRequestSnapshot["status"];
  text?: boolean;
}) {
  const message = () =>
    t(
      props.status === "rate-limited"
        ? "chat.pullRequests.rateLimited"
        : "chat.pullRequests.unavailable",
    );
  return (
    <Show when={props.status !== "ready"}>
      <Show
        when={props.text}
        fallback={
          <openclaw-tooltip content={message()}>
            <span class="chat-pr__warning" role="img" aria-label={message()}>
              <Icon name="alertTriangle" />
            </span>
          </openclaw-tooltip>
        }
      >
        <span class="chat-pr__stale">
          {t(
            props.status === "rate-limited"
              ? "chat.pullRequests.rateLimitedShort"
              : "chat.pullRequests.unavailableShort",
          )}
        </span>
      </Show>
    </Show>
  );
}
