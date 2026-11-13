import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveSessionCreationVisibility } from "../../config/sessions/creation-visibility.js";
import { buildSessionCreationStamp } from "../../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertPreparedSkillLibrarySelection } from "../../skills/library/selection.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { prepareSkillLibrarySessionCreation } from "../skill-library-session.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import { isAttendedControlUiSessionCreator } from "./gateway-personal-caller.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

// Preparing the canonical creator defaults does not itself persist a session.
export async function prepareChatSendSessionEntry(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  client: GatewayRequestHandlerOptions["client"];
  inputProvenance?: NormalizedChatSendRequest["systemInputProvenance"];
  agentId: string;
  getRuntimeConfig: () => OpenClawConfig;
}): Promise<{ entry: SessionEntry; assertSkillSelection: () => void }> {
  const { cfg, client, agentId, getRuntimeConfig } = params;
  const creationError = authorizeGatewaySessionCreation({ cfg, client, agentId });
  if (creationError) {
    throw new Error(creationError.message);
  }
  const stamp = await prepareSkillLibrarySessionCreation(
    client,
    getRuntimeConfig,
    resolveOperatorSessionCreation(client),
  );
  const attendedProfileOperator = () =>
    isAttendedControlUiSessionCreator(client) &&
    (!params.inputProvenance || params.inputProvenance.kind === "external_user") &&
    stamp.via === "operator" &&
    stamp.actor?.type === "human" &&
    stamp.actor.source === "profile" &&
    stamp.actor.id === client?.authenticatedUserProfile?.profileId;
  const creationVisibility = resolveSessionCreationVisibility(cfg, params.sessionKey, undefined, {
    attendedProfileOperator: attendedProfileOperator(),
  });
  const createdAt = Date.now();
  return {
    entry: {
      ...creationVisibility,
      ...buildSessionCreationStamp({
        ...stamp,
        sandbox: resolveCreatorSandbox(cfg, stamp),
        now: createdAt,
      }),
      // A caller's retry ID must never revive a retained transcript window.
      sessionId: randomUUID(),
      lifecycleRevision: randomUUID(),
      updatedAt: createdAt,
      sessionStartedAt: createdAt,
      lastInteractionAt: createdAt,
      chatType: "direct",
    },
    assertSkillSelection: () => {
      assertPreparedSkillLibrarySelection(stamp.skillLibrarySelections);
      const currentVisibility = resolveSessionCreationVisibility(
        getRuntimeConfig(),
        params.sessionKey,
        undefined,
        {
          attendedProfileOperator: attendedProfileOperator(),
        },
      );
      if (!isDeepStrictEqual(creationVisibility, currentVisibility)) {
        throw new Error("Session creation access changed before commit");
      }
    },
  };
}

export async function prepareChatSendInitialEntry({
  request,
  session,
  client,
  context,
}: {
  request: Pick<NormalizedChatSendRequest, "systemInputProvenance" | "goalOperation">;
  session: {
    entry?: SessionEntry;
    requestedSessionId?: string;
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId: string;
  };
  client: GatewayRequestHandlerOptions["client"];
  context: Pick<GatewayRequestHandlerOptions["context"], "getRuntimeConfig">;
}) {
  if (session.entry || session.requestedSessionId) {
    return undefined;
  }
  const inputProvenance = request.systemInputProvenance;
  const access = resolveSessionCreationVisibility(session.cfg, session.sessionKey, undefined, {
    attendedProfileOperator:
      isAttendedControlUiSessionCreator(client) &&
      (!inputProvenance || inputProvenance.kind === "external_user"),
  }).access;
  if (request.goalOperation?.action !== "start" && !access) {
    return undefined;
  }
  return prepareChatSendSessionEntry({
    cfg: session.cfg,
    sessionKey: session.sessionKey,
    client,
    inputProvenance,
    agentId: session.agentId,
    getRuntimeConfig: context.getRuntimeConfig,
  });
}

export function createChatSendCreationDefaultGuard(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  client: GatewayRequestHandlerOptions["client"];
  inputProvenance?: NormalizedChatSendRequest["systemInputProvenance"];
  getRuntimeConfig: () => OpenClawConfig;
  hasSession: () => boolean;
}) {
  const { client, sessionKey, inputProvenance } = params;
  const originalProfileId = client?.authenticatedUserProfile?.profileId;
  const attendedControlUi = () =>
    isAttendedControlUiSessionCreator(client) &&
    client?.authenticatedUserProfile?.profileId === originalProfileId &&
    (!inputProvenance || inputProvenance.kind === "external_user");
  const initialAttendedControlUi = attendedControlUi();
  const creationDefault = resolveSessionCreationVisibility(params.cfg, sessionKey, undefined, {
    attendedProfileOperator: initialAttendedControlUi,
  }).access;
  const assertCreationDefaultCurrent = () => {
    if (!initialAttendedControlUi || params.hasSession()) {
      return;
    }
    const current = resolveSessionCreationVisibility(
      params.getRuntimeConfig(),
      sessionKey,
      undefined,
      { attendedProfileOperator: attendedControlUi() },
    ).access;
    if (!isDeepStrictEqual(creationDefault, current)) {
      throw new Error("Session creation access changed before commit");
    }
  };
  return { initialAttendedControlUi, assertCreationDefaultCurrent };
}
