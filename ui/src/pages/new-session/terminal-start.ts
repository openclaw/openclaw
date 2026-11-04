import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { pathForTerminalSession } from "../../app-route-paths.ts";
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
    hostId: place.terminalHostId,
    cwd: place.folder.trim() || (place.terminalOnNode ? "" : place.workspacePath()),
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
    let cwd = terminalInput.cwd;
    if (terminalInput.worktree) {
      const created = await createManagedWorktree(client, {
        repoRoot: cwd,
        name: terminalInput.worktreeName,
        baseRef: terminalInput.baseRef,
      });
      if (!submission.isCurrent()) {
        return;
      }
      cwd = created.path;
    }
    const result = await startCatalogSessionInTerminal(
      client,
      {
        catalogId,
        agentId,
        hostId: terminalInput.hostId,
        cwd,
        ...(initialMessage ? { initialMessage } : {}),
      },
      submission.isCurrent,
    );
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

export type NewSessionTerminalHostOptions = {
  hosts: Array<{ hostId: string; label: string }> | undefined;
  hostId: string;
  submitting: boolean;
  onSelect: (hostId: string) => void;
};
