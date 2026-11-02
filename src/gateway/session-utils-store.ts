import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { readAcpSessionMetaForEntries } from "../acp/runtime/session-meta-readonly.js";
import { resolveModelAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import {
  listAgentEntries,
  listAgentIds,
  resolveAgentConfig,
  resolveAgentModelFallbacksOverride,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
import { resolveExecDefaults } from "../agents/exec-defaults.js";
import { resolveAgentAvatarUrlFromSource } from "../agents/identity-avatar-file.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import { resolveSandboxRuntimeSettings } from "../agents/sandbox/config.js";
import { SESSION_PERMISSION_BY_EXEC_MODE } from "../agents/session-permission-exec-mode.js";
import { readUtilityModelSetting } from "../agents/utility-model-setting.js";
import { resolveConfiguredPrimaryModelForAgent } from "../agents/utility-model.js";
import { hasWorkspaceGitCheckout } from "../agents/workspace-git.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import {
  resolveAgentMainSessionKey,
  type SessionEntry,
  type SessionScope,
} from "../config/sessions.js";
import type {
  QualifiedSessionEntryAccessTarget,
  SessionEntryReadScope,
} from "../config/sessions/session-accessor.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveExecPolicyForMode } from "../infra/exec-approvals-core.js";
import { loadExecApprovalsReadOnlyAsync } from "../infra/exec-approvals-store.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { isAcpSessionKey } from "../sessions/session-key-utils.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import { listAgentProvenance } from "../state/agent-provenance.js";
import { listGatewayAgentsBasic } from "./agent-list.js";
import type { GatewayAgentOwnership } from "./agent-list.js";
import { resolveGatewayAssistantAvatar } from "./assistant-avatar.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "./session-request-agent.js";
import { captureSessionMutationRouting } from "./session-sharing-preparation.js";
import { resolveGatewayModelThinkingProfile } from "./session-utils-model.js";
import type { GatewaySessionStoreDiscoveryCache } from "./session-utils-store-candidates.js";
import {
  withGatewaySessionStoreTarget,
  resolveNativeGatewaySessionStoreTargetWithStore,
} from "./session-utils-store-lookup.js";
import { withQualifiedGatewaySessionStoreTarget } from "./session-utils-store-retained.js";
import {
  findCanonicalStoreMatch,
  omitInternalSessionEffectsEntries,
} from "./session-utils-store-selection.js";
import type { GatewayAgentRow, SessionListModelCatalog } from "./session-utils.types.js";
import { projectWorkerPlacementAgentRuntime } from "./worker-environments/placement-session-runtime.js";

/**
 * Returns the owning agent id if the session key belongs to an agent that is no
 * longer present in config (deleted). Returns null for non-agent legacy/global
 * keys, confirmed ACP runtime session keys, or when the owning agent still
 * exists (#65524).
 */
export function resolveDeletedAgentIdFromSessionKey(
  cfg: OpenClawConfig,
  sessionKey: string,
  acpMeta?: SessionEntry["acp"] | null,
): string | null {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return null;
  }
  const agentId = normalizeAgentId(parsed.agentId);
  if (listAgentIds(cfg).includes(agentId)) {
    return null;
  }
  if (isAcpSessionKey(sessionKey) && !parsed.rest.startsWith("acp:binding:")) {
    // Free ACP runtime keys use agent:<harnessId>:acp:<uuid>, but key shape is
    // not proof: ACP bridge sessions can use ACP-shaped keys without SessionAcpMeta.
    // Configured acp:binding keys stay owner-scoped even when ACP metadata exists.
    if (acpMeta) {
      return null;
    }
  }
  return agentId;
}

export function prepareDeletedAgentSessionCheck(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  entry?: SessionEntry | null;
  acpMetadataSessionKey?: string | null;
  assertCurrent?: () => void;
}): string | null | Promise<string | null> {
  const deletedAgentId = resolveDeletedAgentIdFromSessionKey(params.cfg, params.sessionKey);
  if (
    deletedAgentId === null ||
    !isAcpSessionKey(params.sessionKey) ||
    parseAgentSessionKey(params.sessionKey)?.rest.startsWith("acp:binding:")
  ) {
    return deletedAgentId;
  }
  const keys = new Set([
    normalizeOptionalString(params.acpMetadataSessionKey) ?? params.sessionKey,
    params.sessionKey,
  ]);
  // The reader captures physical shared-state identity before yielding and binds
  // both canonical and legacy keys to the selected session lifecycle.
  params.assertCurrent?.();
  return readAcpSessionMetaForEntries({
    cfg: params.cfg,
    entries: Array.from(keys, (sessionKey) => ({
      sessionKey,
      agentId:
        parseAgentSessionKey(sessionKey)?.agentId ??
        tryResolveSessionCompatibilityOwnerAgentId(params.cfg, sessionKey) ??
        deletedAgentId,
      entry: params.entry ?? undefined,
    })),
  }).then((metadata) => {
    params.assertCurrent?.();
    return metadata.some(Boolean) ? null : deletedAgentId;
  });
}

export function loadIncognitoGatewaySessionEntryReadOnly(
  sessionKey: string,
  opts?: Pick<SessionEntryReadScope, "agentId" | "clone" | "projection" | "env"> & {
    targetDiscoveryCache?: GatewaySessionStoreDiscoveryCache;
  },
  cfg: OpenClawConfig = getRuntimeConfig(),
) {
  const key = normalizeOptionalString(sessionKey) ?? "";
  if (!isIncognitoSessionKey(key)) {
    throw new Error("Durable session entries require the asynchronous Gateway reader");
  }
  const target = resolveNativeGatewaySessionStoreTargetWithStore({
    cfg,
    key,
    exactRead: true,
    readOnly: true,
    projection: opts?.projection,
    env: opts?.env,
    targetDiscoveryCache: opts?.targetDiscoveryCache,
    ...(opts?.clone === false ? { clone: false } : {}),
    ...(opts?.agentId ? { agentId: opts.agentId } : {}),
  });
  const storePath = target.storePath;
  const store = target.store;
  const canonicalMatch = findCanonicalStoreMatch(store, target.storeKeys);
  const legacyKey = canonicalMatch?.key !== target.canonicalKey ? canonicalMatch?.key : undefined;
  const entry =
    opts?.clone !== false && canonicalMatch?.entry
      ? structuredClone(canonicalMatch.entry)
      : canonicalMatch?.entry;
  return {
    cfg,
    agentId: target.agentId,
    storePath,
    store,
    ...(target.readSource ? { readSource: target.readSource } : {}),
    ...(target.capturedReadSource ? { capturedReadSource: target.capturedReadSource } : {}),
    ...(target.capturedReadSources ? { capturedReadSources: target.capturedReadSources } : {}),
    ...(target.lifecycleTimestamps ? { lifecycleTimestamps: target.lifecycleTimestamps } : {}),
    entry,
    canonicalKey: target.canonicalKey,
    storeKeys: target.storeKeys,
    legacyKey,
  };
}

export type GatewaySessionEntryRead = ReturnType<typeof loadIncognitoGatewaySessionEntryReadOnly>;

export async function loadGatewaySessionEntryReadOnlyAsync(
  sessionKey: string,
  opts?: Parameters<typeof loadIncognitoGatewaySessionEntryReadOnly>[1],
  cfg: OpenClawConfig = getRuntimeConfig(),
) {
  const { loadGatewaySessionEntryReadOnlyInWorker } =
    await import("./session-utils-store-worker.js");
  return loadGatewaySessionEntryReadOnlyInWorker({ cfg, key: sessionKey, ...opts, readOnly: true });
}

/** Consume exact row facts synchronously while their physical worker owners remain retained. */
export async function withGatewaySessionEntry<T>(
  sessionKey: string,
  opts:
    | (Pick<SessionEntryReadScope, "agentId" | "projection" | "env"> & {
        includeMembership?: boolean;
      })
    | undefined,
  consume: (
    session: GatewaySessionEntryRead,
    membership: ReadonlyMap<
      string,
      readonly import("../config/sessions/session-membership-facts.types.js").SessionMember[]
    >,
    assertSourceCurrent: () => void,
  ) => T,
  cfg: OpenClawConfig = getRuntimeConfig(),
  assertConfigCurrent?: () => void,
): Promise<T> {
  const assertRoutingCurrent = captureSessionMutationRouting(cfg, undefined, [
    { sessionKey, agentId: opts?.agentId },
  ]);
  const assertConfig = assertConfigCurrent ?? (() => assertRoutingCurrent(getRuntimeConfig()));
  return withGatewaySessionStoreTarget(
    { cfg, key: sessionKey, ...opts },
    (target, membership, assertSourceCurrent) => {
      omitInternalSessionEffectsEntries(target.store, target.storeKeys);
      const canonicalMatch = findCanonicalStoreMatch(target.store, target.storeKeys);
      const assertCurrent = () => {
        assertSourceCurrent();
        assertConfig();
      };
      assertCurrent();
      return consume(
        {
          cfg,
          ...target,
          entry: canonicalMatch?.entry,
          legacyKey: canonicalMatch?.key !== target.canonicalKey ? canonicalMatch?.key : undefined,
        },
        membership,
        assertCurrent,
      );
    },
  );
}

export async function withQualifiedGatewaySessionEntry<T>(params: {
  cfg: OpenClawConfig;
  target: QualifiedSessionEntryAccessTarget;
  logicalStorePath: string;
  includeMembership: boolean;
  transcript?: import("../config/sessions/session-entry-read.types.js").SessionExactEntriesWorkerRequest["transcript"];
  includeLifecycle?: boolean;
  consume: Parameters<typeof withGatewaySessionEntry<T>>[2];
  assertConfigCurrent: () => void;
}): Promise<T> {
  return withQualifiedGatewaySessionStoreTarget({
    ...params,
    readOptions: {
      transcript: params.transcript,
      lifecycleSessionKey: params.includeLifecycle ? params.target.storeKey : undefined,
    },
    consume: (target, membership, assertSourceCurrent) => {
      const canonicalMatch = findCanonicalStoreMatch(target.store, target.storeKeys);
      // Qualification retains the selected store key even before its row exists.
      const storeKey = canonicalMatch?.key ?? params.target.storeKey;
      const assertCurrent = () => {
        assertSourceCurrent();
        params.assertConfigCurrent();
      };
      assertCurrent();
      return params.consume(
        {
          cfg: params.cfg,
          ...target,
          entry: canonicalMatch?.entry,
          legacyKey: storeKey !== target.canonicalKey ? storeKey : undefined,
        },
        membership,
        assertCurrent,
      );
    },
  });
}

export function resolveCanonicalSessionEntryFromStoreKeys(
  store: Record<string, SessionEntry>,
  storeKeys: string[],
): SessionEntry | undefined {
  return findCanonicalStoreMatch(store, storeKeys)?.entry;
}

export function resolveCanonicalGatewaySessionStoreKey(params: {
  cfg: OpenClawConfig;
  key: string;
  store: Record<string, SessionEntry>;
  agentId?: string;
  target: import("./session-utils-store.types.js").GatewaySessionStoreTarget;
}) {
  const target = params.target;
  const primaryKey = target.canonicalKey;
  findCanonicalStoreMatch(params.store, target.storeKeys);
  return { target, primaryKey, entry: params.store[primaryKey] };
}

export function parseGroupKey(
  key: string,
): { channel?: string; kind?: "group" | "channel"; id?: string } | null {
  const agentParsed = parseAgentSessionKey(key);
  const rawKey = agentParsed?.rest ?? key;
  const parts = rawKey.split(":").filter(Boolean);
  if (parts.length >= 3) {
    const [channel, kind, ...rest] = parts;
    if (kind === "group" || kind === "channel") {
      const id = rest.join(":");
      return { channel, kind, id };
    }
  }
  return null;
}

export function isGroupOrChannelDisplaySession(
  entry: SessionEntry | undefined,
  parsed: { kind?: "group" | "channel" } | null,
): boolean {
  return (
    entry?.chatType === "group" ||
    entry?.chatType === "channel" ||
    parsed?.kind === "group" ||
    parsed?.kind === "channel"
  );
}

function resolveGatewayAgentModel(
  cfg: OpenClawConfig,
  agentId: string,
  resolvedModel: ReturnType<typeof resolveDefaultModelForAgent>,
): NonNullable<GatewayAgentRow["model"]> {
  // Agent rows expose model identity to clients; credential-profile binding stays in
  // canonical config and is consumed only by execution-time model selection.
  const primary = `${resolvedModel.provider}/${resolvedModel.model}`;
  const utilityOnly =
    !resolveConfiguredPrimaryModelForAgent({ cfg, agentId }) &&
    readUtilityModelSetting(cfg, agentId).kind === "explicit";
  const fallbackOverride = resolveAgentModelFallbacksOverride(cfg, agentId);
  const defaultFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
  const fallbacks = dedupeByKey(
    (fallbackOverride ?? defaultFallbacks)
      .map((value) => splitTrailingAuthProfile(value).model.trim())
      .filter(Boolean),
    normalizeLowercaseStringOrEmpty,
  );
  return {
    ...(utilityOnly ? {} : { primary }),
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
  };
}

function resolvedPermissionLabel(
  policy: Pick<ReturnType<typeof resolveExecDefaults>, "mode" | "security" | "ask">,
): GatewayAgentRow["defaultPermissionMode"] {
  const { mode } = policy;
  const canonical = resolveExecPolicyForMode(mode);
  // Display resolved posture, never authorization. Allowlist has no matching
  // session mode; lossy security/ask pairs must also remain unlabeled.
  return mode !== "allowlist" &&
    policy.security === canonical.security &&
    policy.ask === canonical.ask
    ? SESSION_PERMISSION_BY_EXEC_MODE[mode]
    : undefined;
}

export async function listAgentsForGateway(
  cfg: OpenClawConfig,
  options?: {
    modelCatalogByAgentId?: SessionListModelCatalog;
    includeSystem?: boolean;
    httpAvatarBasePath?: string;
    /** Limit enrichment while retaining the Gateway's canonical routing metadata. */
    agentIds?: ReadonlySet<string>;
  },
): Promise<{
  defaultId: string;
  ownership: GatewayAgentOwnership;
  selectionRequired: boolean;
  mainKey: string;
  scope: SessionScope;
  agents: GatewayAgentRow[];
}> {
  const [basic, provenanceRecords, execApprovals] = await Promise.all([
    listGatewayAgentsBasic(cfg),
    listAgentProvenance(),
    loadExecApprovalsReadOnlyAsync(),
  ]);
  const roster = basic.agents.filter(
    (entry) =>
      (options?.includeSystem || entry.kind !== "system") &&
      (!options?.agentIds || options.agentIds.has(entry.id)),
  );
  const rosterIds = new Set(roster.map((entry) => entry.id));
  const identityById = new Map<string, GatewayAgentRow["identity"]>();
  for (const entry of listAgentEntries(cfg)) {
    if (!entry?.id) {
      continue;
    }
    const agentId = normalizeAgentId(entry.id);
    if (!rosterIds.has(agentId)) {
      continue;
    }
    const avatar = normalizeOptionalString(entry.identity?.avatar);
    const httpAvatar =
      avatar && options?.httpAvatarBasePath !== undefined
        ? (
            await resolveGatewayAssistantAvatar({
              cfg,
              identity: { agentId, avatar },
              httpBasePath: options.httpAvatarBasePath,
            })
          ).avatar
        : undefined;
    const avatarUrl = httpAvatar ?? (await resolveAgentAvatarUrlFromSource(cfg, agentId, avatar));
    const identity = entry.identity
      ? {
          name: normalizeOptionalString(entry.identity.name),
          theme: normalizeOptionalString(entry.identity.theme),
          emoji: normalizeOptionalString(entry.identity.emoji),
          avatar: httpAvatar ?? avatar,
          avatarUrl,
        }
      : undefined;
    identityById.set(agentId, identity);
  }
  const provenanceById = new Map(
    provenanceRecords.map((record) => [record.agentId, record] as const),
  );
  const agents = roster.map((entry) => {
    const { id } = entry;
    // This label must never overstate permissiveness. When sandbox policy can vary
    // by session, the effective policy is unknowable at agent scope: omit the label.
    const defaultPermissionMode =
      resolveSandboxRuntimeSettings(
        cfg.agents?.defaults?.sandbox,
        resolveAgentConfig(cfg, id)?.sandbox,
      ).mode === "off"
        ? resolvedPermissionLabel(resolveExecDefaults({ cfg, agentId: id, execApprovals }))
        : undefined;
    const resolvedModel = resolveDefaultModelForAgent({ cfg, agentId: id });
    const model = resolveGatewayAgentModel(cfg, id, resolvedModel);
    const utilitySetting = readUtilityModelSetting(cfg, id);
    const selectionParams = { cfg, agentId: id, defaultProvider: resolvedModel.provider };
    const utility =
      utilitySetting.kind === "explicit"
        ? resolveModelRefFromString({
            ...selectionParams,
            raw: utilitySetting.modelRef,
            aliasIndex: buildModelAliasIndex(selectionParams),
          })?.ref
        : undefined;
    const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: id });
    const agentRuntime = projectWorkerPlacementAgentRuntime(
      resolveModelAgentRuntimeMetadata({
        cfg,
        agentId: id,
        provider: resolvedModel.provider,
        model: resolvedModel.model,
        sessionKey,
        acpRuntime: false,
      }),
    );
    const hasAgentCatalog = options?.modelCatalogByAgentId?.has(id);
    // Unconfigured system rows inherit the default catalog; keep its provider
    // policy attached. A configured owner with no catalog must not inherit it.
    const preparedCatalog = options?.modelCatalogByAgentId?.get(
      hasAgentCatalog ? id : basic.defaultId,
    );
    const thinkingProfile = resolveGatewayModelThinkingProfile({
      cfg,
      agentId: id,
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      modelCatalog: preparedCatalog?.entries,
      sessionKey,
      providerPolicySource: preparedCatalog?.pluginRegistry,
    });
    const workspace = resolveAgentWorkspaceDir(cfg, id);
    // Must mirror the sessions.create worktree preflight: subdirectory workspaces inside a
    // repo are worktree-capable, so the UI toggle and the create path cannot diverge.
    const workspaceGit = hasWorkspaceGitCheckout(workspace);
    const agent = Object.assign(
      {
        id,
        ...(entry.admissionRefusal
          ? { status: entry.status, admissionRefusal: entry.admissionRefusal }
          : {}),
        ...(options?.includeSystem ? { kind: entry.kind } : {}),
        name: entry.name,
        identity: identityById.get(id),
        workspace,
        workspaceGit,
        agentRuntime,
        // Preserve the established serialized projection order for byte-stable responses.
        thinkingLevels: thinkingProfile.thinkingLevels,
        thinkingOptions: thinkingProfile.thinkingLevels.map((level) => level.label),
        thinkingDefault: thinkingProfile.thinkingDefault,
      },
      { model },
      utility ? { utilityModel: `${utility.provider}/${utility.model}` } : {},
      defaultPermissionMode ? { defaultPermissionMode } : {},
    );
    const provenance = provenanceById.get(id);
    return provenance
      ? Object.assign(agent, {
          createdVia: provenance.createdVia,
          creatorAgentId: provenance.creatorAgentId,
          createdAt: provenance.createdAtMs,
        })
      : agent;
  });
  return {
    defaultId: basic.defaultId,
    ownership: basic.ownership,
    selectionRequired: basic.selectionRequired,
    mainKey: basic.mainKey,
    scope: basic.scope,
    agents,
  };
}
