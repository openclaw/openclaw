import { createMemo, For, onSettled, Show } from "solid-js";
import type { ControlUiSessionPullRequest } from "../../../../src/gateway/control-ui-contract.js";
import type { ControlUiLinkReaderPreview } from "../../../../src/shared/control-ui-link-reader.js";
import type { ApplicationContext } from "../../app/context.ts";
import { availableLinkPreviewReaders } from "../../app/link-reader-routing.ts";
import { SessionGitDiff } from "../../components/session-git-diff.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import "../../components/link-reader-hovercard-registration.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import {
  orderSessionPullRequests,
  sessionPullRequestStateIcons,
} from "../../lib/session-pull-request-presentation.ts";
import { sessionPullRequestsForGateway } from "../../lib/session-pull-requests.ts";

registerEnglishCatalog(registerActivityEnglish);

function pullRequestPreview(pr: ControlUiSessionPullRequest): ControlUiLinkReaderPreview {
  return {
    url: pr.url,
    title: pr.title,
    subtitle: pr.owner + "/" + pr.repo + " #" + pr.number,
    badge: {
      label: t("activity.git." + pr.state),
      tone:
        pr.state === "merged"
          ? "accent"
          : pr.state === "open"
            ? "positive"
            : pr.state === "closed"
              ? "negative"
              : "neutral",
    },
    author: pr.author?.login,
    authorUrl: pr.author?.login
      ? "https://github.com/" + encodeURIComponent(pr.author.login)
      : undefined,
    metadata: [
      ...(pr.additions === undefined
        ? []
        : [{ label: "", value: "+" + pr.additions, tone: "positive" as const }]),
      ...(pr.deletions === undefined
        ? []
        : [{ label: "", value: "−" + pr.deletions, tone: "negative" as const }]),
    ],
  };
}

function PullRequest(props: { value: ControlUiSessionPullRequest }) {
  return (
    <a
      class="activity-feed__pr"
      data-state={props.value.state}
      href={props.value.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t("activity.git.pullRequest", {
        repository: `${props.value.owner}/${props.value.repo}`,
        number: String(props.value.number),
        title: props.value.title,
        state: t(`activity.git.${props.value.state}`),
      })}
    >
      <span class="activity-feed__git-icon" aria-hidden="true">
        <Icon name={sessionPullRequestStateIcons[props.value.state]} />
      </span>
      <span class="activity-feed__git-label">
        {props.value.repo}#{props.value.number}
      </span>
      <SessionGitDiff classPrefix="activity-feed" item={props.value} />
    </a>
  );
}

type ActivitySessionGitProps = {
  context: ApplicationContext;
  sessionKey?: string;
  agentId?: string;
};

export function ActivitySessionGit(props: ActivitySessionGitProps) {
  const scope = createMemo(
    () => ({ gateway: props.context.gateway, key: props.sessionKey ?? "" }),
    { equals: (a, b) => a.gateway === b.gateway && a.key === b.key },
  );
  return (
    <Show when={scope()} keyed>
      {(source) => SessionGit(source, props)}
    </Show>
  );
}

function SessionGit(
  source: { gateway: ApplicationContext["gateway"]; key: string },
  props: ActivitySessionGitProps,
) {
  const token = {};
  const store = sessionPullRequestsForGateway(source.gateway);
  const gatewayProjection = projectGateway(source.gateway);
  const projection = projectOwner(store, (owner) => owner.get(source.key));
  // Each keyed Gateway/session scope owns exactly one remote watch.
  onSettled(() => {
    store.watch(token, [source.key], { foreground: true });
    return () => store.unwatch(token);
  });
  const connection = () => gatewayProjection.read().snapshot;
  const snapshot = () => projection.read();
  const branch = createMemo(() => {
    const current = snapshot();
    return current?.pullRequests.some((pr) => pr.state === "open" || pr.state === "draft")
      ? undefined
      : current?.branch;
  });
  const pullRequests = createMemo(() => orderSessionPullRequests(snapshot()?.pullRequests ?? []));
  const visible = () => Boolean(branch() || pullRequests().length);
  const stale = () => snapshot()?.status !== "ready" || connection().phase !== "connected";
  return (
    <openclaw-activity-session-git>
      <Show when={visible()}>
        <openclaw-link-reader-hovercard-provider
          prop:client={connection().client}
          prop:readers={availableLinkPreviewReaders(connection())}
          prop:agentId={props.agentId ?? ""}
          prop:sessionKey={props.sessionKey}
          prop:previewSeeds={pullRequests().map(pullRequestPreview)}
        >
          <div class="activity-feed__git">
            <Show when={branch()}>
              {(current) => (
                <span
                  class="activity-feed__branch"
                  title={t("activity.git.branchDiff", { branch: current().branch })}
                >
                  <span class="activity-feed__git-icon" aria-hidden="true">
                    <Icon name="gitBranch" />
                  </span>
                  <span class="activity-feed__git-label">{current().branch}</span>
                  <SessionGitDiff classPrefix="activity-feed" item={current()} />
                </span>
              )}
            </Show>
            <For each={pullRequests()} keyed={(pr) => pr.url}>
              {(pr) => <PullRequest value={pr()} />}
            </For>
            <Show when={stale()}>
              <span
                class="activity-feed__git-stale"
                role="img"
                aria-label={t("activity.git.stale")}
                title={t("activity.git.stale")}
              >
                <Icon name="alertTriangle" />
              </span>
            </Show>
          </div>
        </openclaw-link-reader-hovercard-provider>
      </Show>
    </openclaw-activity-session-git>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-activity-session-git": HTMLAttributes<HTMLElement>;
    }
  }
}
