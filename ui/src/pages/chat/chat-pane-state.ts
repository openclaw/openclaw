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

export function resolveSessionParticipationBlocked(params: {
  catalog: boolean;
  session: Pick<GatewaySessionRow, "sharingRole" | "visibility"> | undefined;
}): boolean {
  if (params.catalog) {
    return false;
  }
  // A missing row may be a newly redacted draft; never reopen mutation controls.
  if (!params.session) {
    return true;
  }
  if (params.session.visibility === "draft") {
    return params.session.sharingRole !== "admin" && params.session.sharingRole !== "owner";
  }
  return (
    params.session.visibility !== undefined &&
    params.session.visibility !== "shared" &&
    params.session.sharingRole === "viewer"
  );
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
