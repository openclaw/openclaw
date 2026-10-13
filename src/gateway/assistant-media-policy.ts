import { createHmac, randomBytes } from "node:crypto";
import {
  asDateTimestampMs,
  resolveTimestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { isCloudWorkerPlacementState } from "../../packages/gateway-protocol/src/schema/session-placement-state.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { resolveSessionPermissionCoreToolPolicy } from "../agents/session-permission-exec-mode.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../agents/tool-fs-policy.js";
import { getRuntimeConfig } from "../config/io.js";
import { captureIncognitoSessionSource } from "../config/sessions/session-incognito-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { FsSafeError } from "../infra/fs-safe.js";
import { getAgentScopedMediaLocalRoots, getDefaultMediaLocalRoots } from "../media/local-roots.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import { captureResidentUserProfileAccess } from "../state/user-profile-list.js";
import { applyHttpOperatorRoleScopeCeiling, resolveHttpProfile } from "./http-auth-user-profile.js";
import type { AuthorizedControlUiReadRequest } from "./http-auth-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { createProfileSessionEntryFilter } from "./session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import { resolveSessionWorkerPlacementContext } from "./session-worker-placement-context.js";
import { resolveSessionWorkspaceRoots } from "./session-workspace-roots.js";

type AssistantMediaSession = {
  sessionKey: string;
  agentId: string;
  sessionId: string;
};

export function assertAssistantMediaPolicyCurrent(
  selection: Parameters<typeof resolveAssistantMediaPolicy>[0],
  policy: NonNullable<ReturnType<typeof resolveAssistantMediaPolicy>>,
  hasAllowance: boolean,
  requestAuth: AuthorizedControlUiReadRequest | undefined,
) {
  policy.assertCurrent?.();
  // Ordinary session activity changes the global access epoch without revoking media tickets.
  const current = resolveAssistantMediaPolicy({ ...selection, reader: policy.reader });
  if (
    requestAuth?.hasCurrentClientAuthority?.() === false ||
    !current ||
    current.session?.sessionKey !== policy.session?.sessionKey ||
    current.session?.agentId !== policy.session?.agentId ||
    current.session?.sessionId !== policy.session?.sessionId ||
    current.remote !== policy.remote ||
    current.executionCwd !== policy.executionCwd ||
    current.workspaceOnly !== policy.workspaceOnly ||
    current.localRoots.length !== policy.localRoots.length ||
    current.localRoots.some((root, index) => root !== policy.localRoots[index]) ||
    (hasAllowance && policy.workspaceOnly && !current.canAllow)
  ) {
    throw new FsSafeError("path-mismatch", "Media access changed");
  }
  return current;
}

export type AssistantMediaReader = Pick<
  AuthorizedControlUiReadRequest,
  "authMethod" | "operatorScopes"
> & {
  profileId?: string;
};

function resolveAssistantMediaReaderAuth(
  reader: AssistantMediaReader,
  config: OpenClawConfig,
): AuthorizedControlUiReadRequest | undefined {
  try {
    const currentProfile = reader.profileId
      ? resolveHttpProfile(
          captureResidentUserProfileAccess(reader.profileId).assertCurrent().id,
          config,
        )
      : undefined;
    const operatorScopes = applyHttpOperatorRoleScopeCeiling(reader.operatorScopes, currentProfile);
    if (!authorizeOperatorScopesForMethod("assistant.media.get", operatorScopes).allowed) {
      return undefined;
    }
    return { authMethod: reader.authMethod, operatorScopes, ...currentProfile };
  } catch {
    return undefined;
  }
}

export function resolveAssistantMediaPolicy(params: {
  config: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  requestAuth?: AuthorizedControlUiReadRequest;
  reader?: AssistantMediaReader;
}) {
  let loaded:
    | Pick<
        ReturnType<typeof loadGatewaySessionEntryReadOnly>,
        "cfg" | "agentId" | "canonicalKey" | "entry"
      >
    | undefined;
  let assertCurrent: (() => void) | undefined;
  if (params.sessionKey) {
    const owner = resolveRequestedSessionAgentId(params.config, params.sessionKey, params.agentId);
    if (!owner.ok) {
      return undefined;
    }
    const canonicalKey = normalizeSessionKeyPreservingOpaquePeerIds(params.sessionKey);
    const source = captureIncognitoSessionSource({
      sessionKey: canonicalKey,
      agentId: owner.agentId,
    });
    if (source) {
      if ("kind" in source) {
        return undefined;
      }
      const media = source.actor.sessions.readMedia(canonicalKey);
      if (!media) {
        return undefined;
      }
      const claim = source.actor.sessions.captureCurrent(canonicalKey);
      assertCurrent = () => {
        source.admissionSignal?.throwIfAborted();
        source.actor.assertReadable();
        claim.assertCurrent();
      };
      assertCurrent();
      loaded = {
        cfg: getRuntimeConfig(),
        agentId: owner.agentId,
        canonicalKey,
        entry: { ...media, ...source.actor.sessions.readSharing(canonicalKey)?.entry },
      };
    } else {
      loaded = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId: owner.agentId });
    }
    if (!loaded.entry?.sessionId) {
      return undefined;
    }
  }
  // Session storage reads the committed runtime config, including a reload during file preparation.
  const config = loaded?.cfg ?? params.config;
  const reader =
    params.reader ??
    (params.requestAuth
      ? {
          authMethod: params.requestAuth.authMethod,
          operatorScopes: params.requestAuth.operatorScopes,
          ...(params.requestAuth.authenticatedUserProfile
            ? { profileId: params.requestAuth.authenticatedUserProfile.profileId }
            : {}),
        }
      : undefined);
  const auth =
    params.requestAuth ?? (reader ? resolveAssistantMediaReaderAuth(reader, config) : undefined);
  if (!auth || !reader) {
    return undefined;
  }
  const agentId = loaded?.agentId ?? params.agentId;
  const entry = loaded?.entry;
  const remote = Boolean(entry?.execNode || entry?.repositoryWorkspaceId);
  let session: AssistantMediaSession | undefined;
  let sessionRoot: string | undefined;
  let executionCwd: string | undefined;
  if (loaded && entry && agentId) {
    if (!auth.operatorScopes.includes("operator.admin")) {
      const profileId = auth.authenticatedUserProfile?.profileId;
      if (profileId && profileId !== GATEWAY_OWNER_PROFILE_ID) {
        // Match artifact reads: named people cannot read incognito; named roles
        // additionally apply the session catalog's creator/visibility ceiling.
        if (entry.incognito || isIncognitoSessionKey(loaded.canonicalKey)) {
          return undefined;
        }
        if (
          auth.operatorRolePolicy &&
          !createProfileSessionEntryFilter({
            profileId,
            sessionCap: auth.operatorRolePolicy.sessions.others,
          })(loaded.canonicalKey, entry)
        ) {
          return undefined;
        }
      } else if (!profileId && config.gateway?.roles) {
        return undefined;
      }
    }
    session = { sessionKey: loaded.canonicalKey, agentId, sessionId: entry.sessionId };
    if (!remote) {
      const workspace = resolveSessionWorkspaceRoots(config, agentId, entry);
      sessionRoot = entry.sessionRoot ?? workspace.root;
      executionCwd = workspace.diffCwd;
    }
  }
  const workspaceOnly =
    !session ||
    (entry?.permissionMode
      ? resolveSessionPermissionCoreToolPolicy({ mode: entry.permissionMode }).workspaceOnly
      : resolveEffectiveToolFsWorkspaceOnly({ cfg: config, agentId }));
  const localRoots = [
    ...(remote
      ? getDefaultMediaLocalRoots()
      : getAgentScopedMediaLocalRoots(config, agentId, workspaceOnly ? sessionRoot : undefined)),
  ];
  // Full Access retains established agent-workspace downloads alongside the selected project.
  if (sessionRoot && !localRoots.includes(sessionRoot)) {
    localRoots.push(sessionRoot);
  }
  // Cloud placement owns its filesystem independently of the session exec-node setting.
  const placement = session
    ? resolveSessionWorkerPlacementContext()
        .workerSessionPlacementService?.getMany([session.sessionId])
        .get(session.sessionId)
    : undefined;
  return {
    assertCurrent,
    session,
    executionCwd,
    remote: remote || isCloudWorkerPlacementState(placement?.state),
    localRoots,
    workspaceOnly,
    reader,
    canAllow: auth.operatorScopes.includes("operator.admin"),
  };
}

const CONTROL_UI_ASSISTANT_MEDIA_TICKET_SCOPE = "assistant-media";
const CONTROL_UI_ASSISTANT_MEDIA_TICKET_TTL_MS = 5 * 60 * 1000;
const controlUiAssistantMediaTicketSecret = randomBytes(32);

export type AssistantMediaTicketPayload = {
  scope: typeof CONTROL_UI_ASSISTANT_MEDIA_TICKET_SCOPE;
  source: string;
  exp: number;
  session?: AssistantMediaSession;
  reader: AssistantMediaReader;
  agentId?: string;
  file?: { realPath: string; dev: string; ino: string };
};

function signAssistantMediaTicketPayload(encodedPayload: string): string {
  return createHmac("sha256", controlUiAssistantMediaTicketSecret)
    .update(encodedPayload)
    .digest("base64url");
}

export function createAssistantMediaTicket(
  payloadFields: Omit<AssistantMediaTicketPayload, "scope" | "exp">,
  nowMs = Date.now(),
) {
  const now = asDateTimestampMs(nowMs);
  if (now === undefined) {
    return {};
  }
  const exp = asDateTimestampMs(now + CONTROL_UI_ASSISTANT_MEDIA_TICKET_TTL_MS);
  if (exp === undefined) {
    return {};
  }
  const payload: AssistantMediaTicketPayload = {
    scope: CONTROL_UI_ASSISTANT_MEDIA_TICKET_SCOPE,
    ...payloadFields,
    exp,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = signAssistantMediaTicketPayload(encodedPayload);
  return {
    mediaTicket: `v1.${encodedPayload}.${sig}`,
    mediaTicketExpiresAt: resolveTimestampMsToIsoString(exp),
  };
}

export function verifyAssistantMediaTicket(
  ticket: string | null,
  source: string | undefined,
  agentId: string | undefined,
  nowMs = Date.now(),
): AssistantMediaTicketPayload | undefined {
  const now = asDateTimestampMs(nowMs);
  if (now === undefined) {
    return undefined;
  }
  const parts = ticket?.split(".");
  if (!parts || parts.length !== 3 || parts[0] !== "v1") {
    return undefined;
  }
  const [, encodedPayload, sig] = parts;
  if (!encodedPayload || !sig) {
    return undefined;
  }
  const expectedSig = signAssistantMediaTicketPayload(encodedPayload);
  if (!safeEqualSecret(sig, expectedSig)) {
    return undefined;
  }
  try {
    const decodedPayload = Buffer.from(encodedPayload, "base64url").toString("utf8");
    // SAFETY: The verified signature binds these bytes to a payload minted by this module.
    const payload = JSON.parse(decodedPayload) as Partial<AssistantMediaTicketPayload>;
    const valid =
      payload.scope === CONTROL_UI_ASSISTANT_MEDIA_TICKET_SCOPE &&
      typeof payload.source === "string" &&
      (source === undefined || payload.source === source) &&
      payload.agentId === agentId &&
      typeof payload.reader?.authMethod === "string" &&
      Array.isArray(payload.reader.operatorScopes) &&
      (payload.file === undefined ||
        (typeof payload.file?.realPath === "string" &&
          typeof payload.file.dev === "string" &&
          typeof payload.file.ino === "string")) &&
      typeof payload.exp === "number" &&
      Number.isFinite(payload.exp) &&
      payload.exp >= now;
    // SAFETY: This process alone mints payloads; their signature and requested scope are verified above.
    return valid ? (payload as AssistantMediaTicketPayload) : undefined;
  } catch {
    return undefined;
  }
}
