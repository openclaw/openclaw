import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { scopedSessionArtifactKey } from "../../../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { projectSubagentStatus } from "../chat-subagent-wait.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import { renderChatPullRequests } from "./chat-pull-requests.ts";
import "./chat-subagent-activity-live.ts";
import "./chat-summary-automations.ts";

/** A projection of the pane's accepted session/workspace/PR/child-roster facts. */
export class ChatDetailsSession extends OpenClawLightDomElement {
  @property({ attribute: false }) props?: ChatDetailsProps;
  @property({ type: Boolean }) presented = false;
  @state() private expanded = true;
  @state() private pullRequestsOpen = false;
  @state() private automationsOpen = false;
  private identity = "";

  protected override willUpdate() {
    const identity = JSON.stringify([
      this.props?.sessionKey,
      this.props?.currentAgentId,
      this.props?.selectedSession?.sessionId,
    ]);
    if (identity !== this.identity) {
      this.identity = identity;
      this.expanded = true;
      this.pullRequestsOpen = false;
      this.automationsOpen = false;
    }
  }

  private people(props: ChatDetailsProps) {
    const session = props.selectedSession;
    const creator = session?.createdActor;
    const creatorName = creator?.label || creator?.id;
    const owner = session?.owner?.actor;
    const people = session?.expandedParticipants ?? session?.participants ?? [];
    const count = session?.participantCount ?? people.length;
    return html`<div class="chat-details__people">
      ${creatorName ? html`<div class="chat-details__creator"><span>${t("chat.sessionDetails.createdBy")}</span><span title=${creatorName}>${creatorName}</span></div>` : nothing}
      <details class="chat-details__participants">
        <summary>
          ${icons.users}<span>${t("chat.sessionDetails.participants", { count: String(count) })}</span>${icons.chevronDown}
        </summary>
        ${owner ? html`<div class="chat-details__person"><span>${t("chat.sessionDetails.owner")}</span><span>${owner.label || owner.id || owner.type}</span></div>` : nothing}
        ${people.map(
          (person) => html`<div class="chat-details__person">
            ${renderChatAuthorAvatar({ id: person.identity.id, name: person.label || person.identity.id, identity: person.identity, profileAvatarUrl: person.avatarUrl })}
            <span title=${person.label || person.identity.id}
              >${person.label || person.identity.id}</span
            >
          </div>`,
        )}
        ${count > people.length ? html`<div class="chat-details__muted">${t("chat.sessionDetails.moreParticipants", { count: String(count - people.length) })}</div>` : nothing}
      </details>
    </div>`;
  }

  override render() {
    const props = this.props;
    if (!props) {
      return nothing;
    }
    const identity = this.identity;
    const current = () => this.isConnected && this.presented && this.props === props;
    const workspace = props.detailsWorkspace;
    const subagents = projectSubagentStatus(props, false).activity;
    const active = this.presented && this.expanded;
    const pr = renderChatPullRequests({
      pullRequests: props.pullRequests ?? [],
      gateway: props.pullRequestsGateway,
      sessionId: props.pullRequestsSessionId,
      sessionKey: scopedSessionArtifactKey(props.sessionKey, props.currentAgentId ?? undefined),
      presented: active && this.pullRequestsOpen,
      branch: props.pullRequestsBranch,
      branchDismissed: props.pullRequestsBranchDismissed,
      status: props.pullRequestsStatus ?? "ready",
      onDismiss: (pullRequest) => {
        if (current()) {
          props.onDismissPullRequest?.(pullRequest);
        }
      },
      onDismissBranch: props.onDismissPullRequestsBranch
        ? (branch) => {
            if (current()) {
              props.onDismissPullRequestsBranch?.(branch);
            }
          }
        : undefined,
      onOpenSessionDiff: props.onOpenSessionDiff
        ? () => {
            if (current()) {
              props.onOpenSessionDiff?.();
            }
          }
        : undefined,
      publication: props.githubPublication,
      compact: true,
    });
    return keyed(
      this.identity,
      html`<details
        class="chat-details-session"
        .open=${this.expanded}
        @toggle=${(event: Event) => {
          const disclosure = event.currentTarget;
          if (
            this.identity === identity &&
            disclosure instanceof HTMLDetailsElement &&
            disclosure.isConnected
          ) {
            this.expanded = disclosure.open;
          }
        }}
      >
        <summary class="chat-details__heading">
          ${t("chat.sessionDetails.session")}${icons.chevronDown}
        </summary>
        ${this.people(props)}
        <div class="chat-details__workspace">
          <div class="chat-details__row" title=${workspace?.root ?? ""}>
            ${icons.folder}<span
              >${workspace?.label || workspace?.root || t("chat.sessionDetails.workspaceUnavailable")}</span
            >
          </div>
          ${workspace?.branch ? html`<div class="chat-details__row" title=${workspace.branch}>${icons.gitBranch}<span>${workspace.branch}</span></div>` : nothing}
          ${
            props.onOpenSessionDiff
              ? html`<button
                  type="button"
                  class="chat-details__row"
                  @click=${() => {
                    if (current()) {
                      props.onOpenSessionDiff?.();
                    }
                  }}
                >
                  ${icons.diff}<span>${t("chat.sessionDetails.allChanges")}</span>
                </button>`
              : nothing
          }
        </div>
        ${
          subagents.length
            ? html`<section class="chat-details__subagents">
                <div class="chat-details__caption">
                  ${t("chat.subagentsPanel.title")}<span>${subagents.length}</span>
                </div>
                ${active ? html`<openclaw-chat-subagent-activity .rows=${subagents} .compact=${true} .onOpenSubagent=${props.onOpenSubagent} .onOpenSession=${props.onSessionSelect}></openclaw-chat-subagent-activity>` : nothing}
              </section>`
            : nothing
        }
        <details
          class="chat-details__group"
          data-details-group="pull-requests"
          .open=${this.pullRequestsOpen}
          @toggle=${(event: Event) => {
            const disclosure = event.currentTarget;
            if (
              this.identity === identity &&
              disclosure instanceof HTMLDetailsElement &&
              disclosure.isConnected
            ) {
              this.pullRequestsOpen = disclosure.open;
            }
          }}
        >
          <summary class="chat-details__caption">
            ${t("chat.sessionDetails.pullRequests")}${icons.chevronDown}<span
              >${props.pullRequests?.length || nothing}</span
            >
          </summary>
          ${pr === nothing ? html`<div class="chat-details__muted">${t("chat.sessionDetails.noPullRequests")}</div>` : pr}
        </details>
        <details
          class="chat-details__group"
          data-details-group="automations"
          .open=${this.automationsOpen}
          @toggle=${(event: Event) => {
            const disclosure = event.currentTarget;
            if (
              this.identity === identity &&
              disclosure instanceof HTMLDetailsElement &&
              disclosure.isConnected
            ) {
              this.automationsOpen = disclosure.open;
            }
          }}
        >
          <summary class="chat-details__caption">
            ${t("chat.sessionDetails.automations")}${icons.chevronDown}
          </summary>
          <openclaw-chat-summary-automations
            .gateway=${props.pullRequestsGateway}
            .sessionKey=${scopedSessionArtifactKey(props.sessionKey, props.currentAgentId ?? undefined)}
            .presented=${active && this.automationsOpen}
          ></openclaw-chat-summary-automations>
        </details>
      </details>`,
    );
  }
}
customElements.define("openclaw-chat-details-session", ChatDetailsSession);
