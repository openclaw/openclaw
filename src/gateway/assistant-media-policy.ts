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
import { captureSessionEntryMetadataRead } from "../config/sessions/session-entry-source-authority.js";
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
import type { GatewaySessionEntryRead } from "./session-utils.js";
import { resolveSessionWorkerPlacementContext } from "./session-worker-placement-context.js";
import { resolveSessionWorkspaceRoots } from "./session-workspace-roots.js";
import { readSessionWorkerPlacementAsync } from "./worker-environments/session-placement-lifecycle.js";

type AssistantMediaSession = {
  sessionKey: string;
  agentId: string;
  sessionId: string;
};

export function assertAssistantMediaPolicyCurrent(
  selection: Parameters<typeof resolveAssistantMediaPolicy>[0],
  policy: NonNullable<Awaited<ReturnType<typeof resolveAssistantMediaPolicy>>>,
  hasAllowance: boolean,
  requestAuth: AuthorizedControlUiReadRequest | undefined,
) {
  policy.assertCurrent?.();
  // Ordinary session activity changes the global access epoch without revoking media tickets.
  const current = resolvePreparedAssistantMediaPolicy(
    { ...selection, reader: policy.reader },
    policy.readSession(),
    policy.readSession,
    policy.assertCurrent,
  );
  if (current?.session) {
    const placement = policy.placementRead
      ? policy.placementRead.current()
      : resolveSessionWorkerPlacementContext()
          .workerSessionPlacementService?.getMany([current.session.sessionId])
          .get(current.session.sessionId);
    current.remote ||= isCloudWorkerPlacementState(placement?.state);
  }
  if (
    requestAuth?.hasCurrentClientAuthority?.() === false ||
    !current ||
    current.session?.sessionKey !== policy.session?.sessionKey ||
    current.session?.agentId !== policy.session?.agentId ||
    current.session?.sessionId !== policy.session?.sessionId ||
    current.messageId !== policy.messageId ||
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

type AssistantMediaReader = Pick<
  AuthorizedControlUiReadRequest,
  "authMethod" | "operatorScopes"
> & {
  profileId?: string;
};

function resolveAssistantMediaReaderAuth(
  reader: AssistantMediaReader,
  config: OpenClawConfig,
  messageRead: boolean,
): AuthorizedControlUiReadRequest | undefined {
  try {
    const currentProfile = reader.profileId
      ? resolveHttpProfile(
          captureResidentUserProfileAccess(reader.profileId).assertCurrent().id,
          config,
        )
      : undefined;
    const operatorScopes = applyHttpOperatorRoleScopeCeiling(reader.operatorScopes, currentProfile);
    if (
      !authorizeOperatorScopesForMethod(
        messageRead ? "chat.message.get" : "assistant.media.get",
        operatorScopes,
      ).allowed
    ) {
      return undefined;
    }
    return { authMethod: reader.authMethod, operatorScopes, ...currentProfile };
  } catch {
    return undefined;
  }
}

type AssistantMediaPolicyParams = {
  config: OpenClawConfig;
  sessionKey?: string;
  messageId?: string;
  agentId?: string;
  requestAuth?: AuthorizedControlUiReadRequest;
  reader?: AssistantMediaReader;
};
type AssistantMediaSessionRead = Pick<
  GatewaySessionEntryRead,
  "cfg" | "agentId" | "canonicalKey" | "entry"
> &
  Partial<Pick<GatewaySessionEntryRead, "storePath" | "readSource">>;

async function resolveAssistantMediaSessionPolicy(params: AssistantMediaPolicyParams) {
  let loaded: AssistantMediaSessionRead | undefined;
  let readSession = (): AssistantMediaSessionRead | undefined => loaded;
  let assertCurrent: (() => void) | undefined;
  let releaseSession: (() => void) | undefined;
  let policy: ReturnType<typeof resolvePreparedAssistantMediaPolicy>;
  try {
    if (params.sessionKey) {
      const owner = resolveRequestedSessionAgentId(
        params.config,
        params.sessionKey,
        params.agentId,
      );
      if (!owner.ok) {
        return undefined;
      }
      const canonicalKey = normalizeSessionKeyPreservingOpaquePeerIds(params.sessionKey);
      const source = captureSessionEntryMetadataRead(
        { sessionKey: canonicalKey, agentId: owner.agentId },
        () => {
          if (params.requestAuth?.hasCurrentClientAuthority?.() === false) {
            throw new FsSafeError("path-mismatch", "Media access changed");
          }
        },
      );
      if (source) {
        assertCurrent = source.assertCurrent;
        readSession = () => ({
          cfg: getRuntimeConfig(),
          agentId: owner.agentId,
          canonicalKey,
          entry: source.readCurrent(),
        });
        loaded = readSession();
      } else {
        const { retainGatewaySessionEntryReadOnly } =
          await import("./session-utils-read-lifetime.js");
        const durable = await retainGatewaySessionEntryReadOnly(
          params.sessionKey,
          owner.agentId,
          // The media policy below checks current permissions and roots; unrelated
          // transcript activity must not turn an evicted row cache into revocation.
          () => true,
          getRuntimeConfig(),
          { exactRead: true },
        );
        releaseSession = durable.release;
        assertCurrent = () => {
          if (!durable.isCurrentAtResponse()) {
            throw new FsSafeError("path-mismatch", "Media access changed");
          }
        };
        readSession = () => {
          assertCurrent?.();
          return {
            ...durable,
            cfg: getRuntimeConfig(),
            entry: durable.readRetainedEntry(),
          };
        };
        loaded = readSession();
      }
      if (!loaded?.entry?.sessionId) {
        return undefined;
      }
    }
    policy = resolvePreparedAssistantMediaPolicy(params, loaded, readSession, assertCurrent);
    return policy && { ...policy, releaseSession };
  } finally {
    if (!policy) {
      releaseSession?.();
    }
  }
}

function resolvePreparedAssistantMediaPolicy(
  params: AssistantMediaPolicyParams,
  loaded: AssistantMediaSessionRead | undefined,
  readSession: () => AssistantMediaSessionRead | undefined,
  assertCurrent?: () => void,
) {
  if (params.sessionKey && !loaded?.entry?.sessionId) {
    return undefined;
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
    params.requestAuth ??
    (reader
      ? resolveAssistantMediaReaderAuth(
          reader,
          config,
          Boolean(params.sessionKey && params.messageId),
        )
      : undefined);
  if (!auth || !reader) {
    return undefined;
  }
  const standaloneRead = authorizeOperatorScopesForMethod(
    "assistant.media.get",
    auth.operatorScopes,
  ).allowed;
  const messageId = standaloneRead ? undefined : params.messageId;
  if (
    !standaloneRead &&
    (!messageId ||
      !loaded ||
      !authorizeOperatorScopesForMethod("chat.message.get", auth.operatorScopes).allowed)
  ) {
    return undefined;
  }
  const agentId = loaded?.agentId ?? params.agentId;
  const entry = loaded?.entry;
  const remote = Boolean(entry?.execNode || entry?.repositoryWorkspaceId || entry?.deviceFolder);
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
          (auth.operatorRolePolicy || messageId) &&
          !createProfileSessionEntryFilter({
            profileId,
            sessionCap: auth.operatorRolePolicy?.sessions.others,
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
  return {
    assertCurrent,
    readSession,
    messageId,
    session,
    executionCwd,
    remote,
    localRoots,
    workspaceOnly,
    reader,
    canAllow: auth.operatorScopes.includes("operator.admin"),
  };
}

export async function resolveAssistantMediaPolicy(params: AssistantMediaPolicyParams) {
  const policy = await resolveAssistantMediaSessionPolicy(params);
  if (!policy) {
    return undefined;
  }
  let releasePlacement: (() => void) | undefined;
  try {
    const context = policy.session ? resolveSessionWorkerPlacementContext() : undefined;
    const placementRead =
      policy.session && context?.workerSessionPlacementService?.prepareSessionPlacement
        ? await context.workerSessionPlacementService.prepareSessionPlacement(
            policy.session.sessionId,
          )
        : undefined;
    releasePlacement = () => placementRead?.release();
    if (policy.session && context) {
      const placement = placementRead
        ? placementRead.current()
        : await readSessionWorkerPlacementAsync({ context, sessionId: policy.session.sessionId });
      // Cloud placement owns its filesystem independently of the session exec-node setting.
      policy.remote ||= isCloudWorkerPlacementState(placement?.state);
    }
    return {
      ...policy,
      placementRead,
      release() {
        placementRead?.release();
        policy.releaseSession?.();
      },
    };
  } catch (error) {
    releasePlacement?.();
    policy.releaseSession?.();
    throw error;
  }
}

const CONTROL_UI_ASSISTANT_MEDIA_TICKET_SCOPE = "assistant-media";
const CONTROL_UI_ASSISTANT_MEDIA_TICKET_TTL_MS = 5 * 60 * 1000;
const controlUiAssistantMediaTicketSecret = randomBytes(32);

export type AssistantMediaTicketPayload = {
  scope: typeof CONTROL_UI_ASSISTANT_MEDIA_TICKET_SCOPE;
  source: string;
  exp: number;
  session?: AssistantMediaSession;
  messageId?: string;
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
