import type WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import {
  createGitHubPullRequestDismissals,
  createGitHubPullRequestRenderer,
  type GitHubPullRequestsProps,
} from "@openclaw/github/control-ui-api.js";
import { html, noChange, nothing } from "lit";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { syncAnchoredOverlay } from "../../../components/anchored-overlay.ts";
import { livePresentation, type PresentationValue } from "../../../lit/presentation-binding.ts";
import { getSafeLocalStorage } from "../../../local-storage.ts";
import "../../../components/tooltip.ts";
import "./chat-ci-details.ts";
import "./chat-ci-automation-control.ts";
import { githubPresentationHost } from "./github-presentation-host.ts";

export { chatPullRequestId, chatBranchId } from "@openclaw/github/control-ui-api.js";
export const { listDismissedChatPullRequests, dismissChatPullRequest } =
  createGitHubPullRequestDismissals(getSafeLocalStorage);

type CiPresentationContext = {
  gateway?: ApplicationGateway;
  sessionKey?: string;
  sessionId?: string;
  presented?: PresentationValue;
};

const renderPullRequests = createGitHubPullRequestRenderer<CiPresentationContext>({
  ...githubPresentationHost,
  syncChecksOverlay(element, context) {
    syncAnchoredOverlay(element, "top", { alignment: "end" });
    const presented = context.presented ?? true;
    const isPresented = typeof presented === "boolean" ? presented : presented.isPresented();
    const popup = element.querySelector<WaPopup>(":scope > wa-popup[data-anchored-overlay]");
    if (popup && !isPresented) {
      popup.active = false;
    }
  },
  checksPopupActive(details, context) {
    const presented = context.presented ?? true;
    return typeof presented === "boolean"
      ? noChange
      : livePresentation({
          owner: presented.owner,
          isPresented: () => presented.isPresented() && Boolean(details()?.open),
        });
  },
  renderCi(pullRequest, context) {
    return html`
      <openclaw-chat-ci-automation
        .pullRequest=${pullRequest}
        .gateway=${context.gateway}
        .sessionKey=${context.sessionKey ?? ""}
        .sessionId=${context.sessionId ?? ""}
        .presented=${livePresentation(context.presented ?? true)}
      ></openclaw-chat-ci-automation>
      ${
        pullRequest.checks
          ? html`<openclaw-chat-ci-details
              .pullRequest=${pullRequest}
              .gateway=${context.gateway}
              .sessionKey=${context.sessionKey ?? ""}
              .presented=${livePresentation(context.presented ?? true)}
            ></openclaw-chat-ci-details>`
          : nothing
      }
    `;
  },
});

export function renderChatPullRequests(
  props: Omit<GitHubPullRequestsProps<CiPresentationContext>, "context"> & CiPresentationContext,
) {
  return renderPullRequests({ ...props, context: props });
}
