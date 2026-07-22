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
    sharingSupported: boolean;
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
    // Row absence is only a revocation signal on a sharing-capable gateway. On
    // older or sharing-less gateways a missing row means pagination, filtering,
    // deletion, or an unsupported feature — never a participation block, so we
    // must not disable the composer for an otherwise writable session.
    if (!params.sharingSupported || !params.listLoaded) {
      return false;
    }
    if (params.listLoading) {
      return previous?.blocked === true;
    }
    // A session we could previously see vanishing from the authoritative loaded
    // list while still selected is treated as a redaction (owner switched it to
    // draft): the gateway rejects our mutations, so fail closed rather than
    // leave an enabled composer whose sends will fail. Accepted tradeoff: a
    // session deleted while viewed is also briefly blocked until navigation or
    // reconnect (both clear this state), since the gateway sends no explicit
    // per-connection revocation signal to distinguish redaction from deletion.
    // An explicit signal is tracked as a follow-up (openclaw/openclaw#112760).
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
