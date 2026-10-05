import { html } from "lit";
import type { UsersGitHubStatusResult } from "../../../../packages/gateway-protocol/src/schema/users.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { withPromiseModalHost } from "../../components/promise-modal-host.ts";
import { t } from "../../i18n/index.ts";
import {
  notifyPersonalGitHubConnectionChanged,
  onPersonalGitHubConnectionChanged,
} from "./github-connection-events.ts";
import { GitHubIdentityController } from "./github-identity-controller.ts";
import {
  renderGitHubConnectionError,
  renderGitHubConnectionSetup,
} from "./github-identity-view.ts";

/** Reuse personal setup after sign-in without changing System or agent identity selection. */
export async function completeGitHubSignInConsent(
  client: GatewayBrowserClient,
  profileId: string,
  signal: AbortSignal,
): Promise<void> {
  let redraw = () => {};
  let finish = () => {};
  let retired = false;
  let checkingConnection = false;
  let observedAuthorization: GitHubIdentityController["authorization"] | undefined;
  const checkConnection = async () => {
    if (retired || signal.aborted || checkingConnection) {
      return;
    }
    checkingConnection = true;
    try {
      const status = await client.request<UsersGitHubStatusResult>(
        "users.github.status",
        {},
        { signal },
      );
      if (!retired && !signal.aborted && status.personal.state === "connected") {
        notifyPersonalGitHubConnectionChanged({ client, profileId });
      }
    } catch {
      // The device flow renders its own failures; the next poll or focus checks selection again.
    } finally {
      checkingConnection = false;
    }
  };
  const controller = new GitHubIdentityController({
    requestUpdate: () => {
      redraw();
      const authorization = controller.authorization;
      if (authorization.phase === "pending" && observedAuthorization !== authorization) {
        observedAuthorization = authorization;
        void checkConnection();
      }
    },
    authorizationSucceeded: () => {
      notifyPersonalGitHubConnectionChanged({ client, profileId });
      finish();
    },
  });
  const stop = onPersonalGitHubConnectionChanged((change) => {
    if (change.client === client && change.profileId === profileId) {
      retired = true;
      finish();
    }
  });
  const onFocus = () => void checkConnection();
  window.addEventListener("focus", onFocus);
  controller.sync({
    client,
    connected: true,
    clientRevision: 0,
    target: { kind: "personal", profileId },
    statusReadable: true,
    configurable: false,
    authorizable: true,
  });
  signal.addEventListener("abort", controller.dispose, { once: true });
  try {
    if (signal.aborted) {
      return;
    }
    await controller.verify({ resumeConnectedAuthorization: false });
    if (retired || signal.aborted || controller.personal?.state === "connected") {
      return;
    }
    await withPromiseModalHost({ signal, value: undefined }, (modal) => {
      finish = () => modal.finish(undefined);
      const content = () => html` <openclaw-modal-dialog
        label=${t("githubConnections.connectMine")}
        @modal-cancel=${finish}
      >
        <div class="exec-approval-card" data-github-signin-consent>
          <div class="exec-approval-title">${t("githubConnections.connectMine")}</div>
          <p>${t("githubConnections.personalDescription")}</p>
          ${renderGitHubConnectionError(controller.error)}
          ${renderGitHubConnectionSetup(controller)}
          <div class="exec-approval-actions">
            <button class="btn" @click=${finish}>${t("common.close")}</button>
          </div>
        </div>
      </openclaw-modal-dialog>`;
      redraw = () => modal.render(content);
      redraw();
      if (controller.personal?.state === "disconnected") {
        void controller.startAuthorization();
      }
    });
  } finally {
    retired = true;
    stop();
    window.removeEventListener("focus", onFocus);
    signal.removeEventListener("abort", controller.dispose);
    controller.dispose();
  }
}
