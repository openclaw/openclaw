import type { GatewaySessionRow } from "../../api/types.ts";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";

type SelectedSessionProjectionState = {
  chatEffectiveQueueMode?: GatewaySessionRow["effectiveQueueMode"];
  chatQueueModeOverride?: GatewaySessionRow["queueMode"];
  selectedChatSessionArchived: boolean;
};

export function applySelectedSessionProjection(
  state: SelectedSessionProjectionState,
  session: GatewaySessionRow | undefined,
): session is GatewaySessionRow {
  if (!session) {
    return false;
  }
  state.selectedChatSessionArchived = session.archived === true;
  state.chatQueueModeOverride = session.queueMode;
  state.chatEffectiveQueueMode = session.effectiveQueueMode;
  return true;
}

const MAX_TRACKED_SESSION_ROWS = 256;

export class SessionParticipationTracker {
  private readonly states = new Map<string, { blocked: boolean; seen: boolean }>();

  reset(): void {
    this.states.clear();
  }

  resolve(params: {
    catalog: boolean;
    listLoaded: boolean;
    listLoading: boolean;
    sessionKey: string;
    session: Pick<GatewaySessionRow, "sharingRole" | "visibility"> | undefined;
  }): boolean {
    if (params.catalog) {
      return false;
    }
    const previous = this.states.get(params.sessionKey);
    if (params.session) {
      const blocked =
        params.session.visibility === "draft"
          ? params.session.sharingRole !== "admin" && params.session.sharingRole !== "owner"
          : params.session.visibility !== undefined &&
            params.session.visibility !== "shared" &&
            params.session.sharingRole === "viewer";
      this.remember(params.sessionKey, { blocked, seen: true });
      return blocked;
    }
    if (!params.listLoaded) {
      return false;
    }
    if (params.listLoading) {
      return previous?.blocked === true;
    }
    const blocked = previous?.seen === true;
    this.remember(params.sessionKey, { blocked, seen: previous?.seen === true });
    return blocked;
  }

  private remember(sessionKey: string, state: { blocked: boolean; seen: boolean }): void {
    this.states.delete(sessionKey);
    this.states.set(sessionKey, state);
    if (this.states.size <= MAX_TRACKED_SESSION_ROWS) {
      return;
    }
    const oldest = this.states.keys().next().value;
    if (oldest) {
      this.states.delete(oldest);
    }
  }
}

export function resolveAssistantAttachmentAuthToken(state: {
  hello?: { auth?: { deviceToken?: string | null } | null } | null;
  password?: string | null;
  settings?: { token?: string | null } | null;
}) {
  return resolveControlUiAuthToken(state);
}

export function dismissChatError(state: {
  chatError?: string | null;
  lastError: string | null;
  lastErrorCode?: string | null;
}) {
  state.lastError = null;
  state.lastErrorCode = null;
  state.chatError = null;
}
