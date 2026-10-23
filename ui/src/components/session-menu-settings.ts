import { createEffect, createSignal } from "solid-js";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import {
  selectSessionCommunication,
  type SessionCommunicationMenuAction,
} from "./session-communication-options.ts";
import { createSessionDetails } from "./session-details.ts";

type SessionMenuSettingsOptions = {
  context: () => ApplicationContext | undefined;
  readState: () => {
    session: Pick<GatewaySessionRow, "communication" | "effectiveCommunication"> & {
      target?: { key: string; agentId?: string };
      sessionId: string | null;
    };
    selectionCount: number;
  };
  runAction: (action: SessionCommunicationMenuAction) => void;
};

/** Owns the menu observation lifetime; the capability keeps synchronous row admission. */
export function createSessionMenuSettings(options: SessionMenuSettingsOptions) {
  const [active, setActive] = createSignal(false);
  const details = createSessionDetails({
    captureScope: () => {
      const context = options.context();
      const connection = context?.sessions.captureConnectionScope();
      return context && connection ? { context, sessions: context.sessions, connection } : null;
    },
    isCurrent: (scope) =>
      options.context() === scope.context &&
      options.context()?.sessions === scope.sessions &&
      scope.sessions.isConnectionScopeCurrent(scope.connection),
    row: () => {
      const { session, selectionCount } = options.readState();
      return selectionCount === 1 && session.target
        ? {
            key: session.target.key,
            sessionId: session.sessionId ?? undefined,
            rowMode: "compact" as const,
          }
        : undefined;
    },
    agentId: (row, scope) =>
      options.readState().session.target?.agentId ??
      parseAgentSessionKey(row.key)?.agentId ??
      scope.context.agentSelection.state.selectedId ??
      "main",
  });
  createEffect(
    () => {
      options.context();
      const { session, selectionCount } = options.readState();
      return [active(), session.target, session.sessionId, selectionCount];
    },
    ([isActive]) => {
      if (isActive) {
        details.synchronize();
      }
    },
  );
  const communicationState = () => {
    const state = options.readState();
    return { ...state, session: details.row() ?? state.session };
  };
  return {
    communicationState,
    get communicationAvailable() {
      return Boolean(communicationState().session.effectiveCommunication);
    },
    read: details.read,
    readKey: details.readKey,
    open() {
      setActive(true);
      details.synchronize();
    },
    close() {
      setActive(false);
      details.reset();
    },
    handleSelect(value: string) {
      if (value === "reload-settings") {
        details.retry();
        return true;
      }
      return selectSessionCommunication(value, options.runAction);
    },
  };
}
