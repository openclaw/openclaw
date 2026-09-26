import { html, nothing } from "lit";
import type { SessionsCatalogStartTerminalResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { pathForTerminalSession } from "../../app-route-paths.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import { startCatalogSessionInTerminal } from "../../lib/sessions/catalog-terminal.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { createManagedWorktree } from "../../lib/worktrees/create-worktree.ts";
import { buildLocalUserMessage } from "../chat/user-message-content.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { DraftSubmissionSnapshot } from "./draft-submission-contract.ts";

registerNewSessionSetupEnglish();

export function readNewSessionTerminalStartAccess(
  gateway: Parameters<typeof readSessionMethodAccess>[0],
  worktree: boolean,
): SessionMethodAccess {
  const terminalAccess = readSessionMethodAccess(gateway, {
    method: "sessions.catalog.startTerminal",
    requiredScope: "operator.admin",
  });
  return !terminalAccess.allowed || !worktree
    ? terminalAccess
    : readSessionMethodAccess(gateway, {
        method: "worktrees.create",
        requiredScope: "operator.admin",
      });
}

async function startNewSessionInTerminal(
  client: GatewayBrowserClient,
  params: {
    catalogId: string;
    agentId: string;
    hostId: string;
    cwd: string;
    initialMessage: string;
    worktree: boolean;
    worktreeName: string;
    baseRef: string;
  },
  isCurrent: () => boolean,
): Promise<SessionsCatalogStartTerminalResult | null> {
  let cwd = params.cwd;
  if (params.worktree) {
    const created = await createManagedWorktree(client, {
      repoRoot: cwd,
      name: params.worktreeName,
      baseRef: params.baseRef,
    });
    if (!isCurrent()) {
      return null;
    }
    cwd = created.path;
  }
  return startCatalogSessionInTerminal(
    client,
    {
      catalogId: params.catalogId,
      agentId: params.agentId,
      hostId: params.hostId,
      cwd,
      ...(params.initialMessage ? { initialMessage: params.initialMessage } : {}),
    },
    isCurrent,
  );
}

/** Native startup shares draft custody, but never falls through to chat creation. */
export async function submitDraftInTerminal(options: {
  snapshot: DraftSubmissionSnapshot;
  place: DraftPlaceState;
  flow: {
    readonly message: string;
    canSubmit(): boolean;
    noteBlockedSubmitAttempt(): void;
    setError(message: string): void;
  };
  closeTransientUi: () => void;
  capture: (client: GatewayBrowserClient) => {
    isCurrent: () => boolean;
    isRequestCurrent: () => boolean;
    publish: (message: ReturnType<typeof buildLocalUserMessage>, active: boolean) => void;
    consume: () => Promise<void>;
  };
}) {
  const { context, data } = options.snapshot;
  const { place, flow } = options;
  const client = context?.gateway.snapshot.client;
  const catalogId = data?.catalogId.trim() ?? "";
  const agentId = normalizeAgentId(place.agentId);
  if (!context || !client || !catalogId || !agentId || !flow.canSubmit()) {
    flow.noteBlockedSubmitAttempt();
    return;
  }
  const submission = options.capture(client);
  const initialMessage = flow.message.trim();
  const terminalInput = {
    catalogId,
    agentId,
    hostId: place.terminalHostId,
    cwd: place.folder.trim() || (place.terminalOnNode ? "" : place.workspacePath()),
    initialMessage,
    worktree: place.worktree,
    worktreeName: place.worktreeName,
    baseRef: place.baseRef,
  };
  const consumeWorktreeName = place.captureSubmittedWorktreeName(terminalInput, agentId);
  submission.publish(
    buildLocalUserMessage({ text: initialMessage, createdAt: Date.now() }, "available"),
    true,
  );
  place.browser.close();
  options.closeTransientUi();
  try {
    const result = await startNewSessionInTerminal(client, terminalInput, submission.isCurrent);
    if (!result || !submission.isCurrent()) {
      return;
    }
    await consumeWorktreeName?.();
    if (!submission.isCurrent()) {
      return;
    }
    await submission.consume();
    if (submission.isCurrent()) {
      context.replace("terminal", {
        pathname: pathForTerminalSession(result.sessionId, context.basePath),
        search: "",
        hash: "",
      });
    }
  } catch (error) {
    if (submission.isCurrent()) {
      flow.setError(error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (submission.isRequestCurrent()) {
      submission.publish(null, false);
    }
  }
}

export function renderNewSessionTerminalHost(params: {
  hosts: Array<{ hostId: string; label: string }> | undefined;
  hostId: string;
  submitting: boolean;
  onSelect: (hostId: string) => void;
}) {
  if (!params.hosts) {
    return nothing;
  }
  if (params.hosts.length === 0) {
    return html`<span class="new-session-page__catalog-unavailable" role="status">
      ${t("newSession.nativeHostsUnavailable")}
    </span>`;
  }
  if (params.hosts.length === 1 && params.hosts[0]?.hostId === params.hostId) {
    return nothing;
  }
  return html`<div class="new-session-page__select new-session-page__menu-field">
    <span>${t("newSession.where")}</span>
    <select
      class="new-session-page__trigger"
      aria-label=${t("newSession.where")}
      .value=${params.hostId}
      ?disabled=${params.submitting}
      @change=${(event: Event) => {
        if (event.currentTarget instanceof HTMLSelectElement) {
          params.onSelect(event.currentTarget.value);
        }
      }}
    >
      ${
        !params.hosts.some((host) => host.hostId === params.hostId)
          ? html`<option value=${params.hostId} selected disabled>
              ${t("newSession.chooseNativeHost")}
            </option>`
          : nothing
      }
      ${params.hosts.map(
        (host) => html`<option value=${host.hostId} ?selected=${host.hostId === params.hostId}>
          ${host.label}
        </option>`,
      )}
    </select>
  </div>`;
}
