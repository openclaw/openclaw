import { createEffect, createMemo, For, Show, untrack } from "solid-js";
import type { ControlUiSessionPullRequest } from "../../../../src/gateway/control-ui-contract.js";
import type { ControlUiLinkReaderPreview } from "../../../../src/shared/control-ui-link-reader.js";
import type { ApplicationContext } from "../../app/context.ts";
import { availableLinkPreviewReaders } from "../../app/link-reader-routing.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import "../../components/link-reader-hovercard-registration.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { sessionPullRequestsForGateway } from "../../lib/session-pull-requests.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";

registerEnglishCatalog(registerActivityEnglish);

function renderDiff(item: { additions?: number; deletions?: number }) {
  return (
    <>
      {item.additions === undefined ? undefined : (
        <span class="activity-feed__additions">+{item.additions.toLocaleString()}</span>
      )}
      {item.deletions === undefined ? undefined : (
        <span class="activity-feed__deletions">−{item.deletions.toLocaleString()}</span>
      )}
    </>
  );
}

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
  const icon = () =>
    (
      ({
        open: "gitPullRequest",
        draft: "gitPullRequestDraft",
        merged: "gitMerge",
        closed: "gitPullRequestClosed",
      }) as const
    )[props.value.state];
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
        <Icon name={icon()} />
      </span>
      <span class="activity-feed__git-label">
        {props.value.repo}#{props.value.number}
      </span>
      {renderDiff(props.value)}
    </a>
  );
}

type ActivitySessionGitProps = {
  context: ApplicationContext;
  sessionKey: string;
  agentId: string;
};

export const ActivitySessionGit = defineSolidBridge<ActivitySessionGitProps>(
  "openclaw-activity-session-git",
  (props) => {
    const token = {};
    const initial = untrack(() => ({ gateway: props.context.gateway, key: props.sessionKey }));
    const gatewayProjection = projectGateway(initial.gateway);
    const projection = projectSource(initial, {
      read: ({ gateway, key }) => sessionPullRequestsForGateway(gateway).get(key),
      subscribe: ({ gateway }, notify) => sessionPullRequestsForGateway(gateway).subscribe(notify),
      equality: "revision",
    });
    createEffect(
      () => ({ gateway: props.context.gateway, key: props.sessionKey }),
      ({ gateway, key }) => {
        gatewayProjection.replaceSource(gateway);
        projection.replaceSource({ gateway, key });
        const store = sessionPullRequestsForGateway(gateway);
        store.watch(token, [key], { foreground: true });
        return () => store.unwatch(token);
      },
    );
    const connection = () => gatewayProjection.read().snapshot;
    const snapshot = () => projection.read();
    const branch = createMemo(() => {
      const current = snapshot();
      return current?.pullRequests.some((pr) => pr.state === "open" || pr.state === "draft")
        ? undefined
        : current?.branch;
    });
    const pullRequests = () => snapshot()?.pullRequests ?? [];
    const visible = () => Boolean(branch() || pullRequests().length);
    const stale = () => snapshot()?.status !== "ready" || connection().phase !== "connected";
    return (
      <Show when={visible()}>
        <openclaw-link-reader-hovercard-provider
          prop:client={connection().phase === "connected" ? connection().client : null}
          prop:readers={availableLinkPreviewReaders(connection())}
          prop:agentId={props.agentId}
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
                  {renderDiff(current())}
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
    );
  },
  {
    properties: {
      context: { default: undefined!, attribute: false },
      sessionKey: { default: "" },
      agentId: { default: "" },
    },
  },
);
