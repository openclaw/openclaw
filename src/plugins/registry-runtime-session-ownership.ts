import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import { resolveInitialEmbeddedRunModel } from "../agents/embedded-agent-runner/run/runtime-resolution.js";
import { resolveSessionRuntimeOverrideForProvider } from "../agents/session-runtime-compat.js";
import {
  parseSqliteSessionFileMarker,
  sqliteSessionFileMarkerMatchesTarget,
} from "../config/sessions/legacy-sqlite-marker.js";
import { resolveSessionEntryAccessTarget } from "../config/sessions/session-accessor.entry.js";
import { resolveSqliteSessionKey } from "../config/sessions/session-accessor.sqlite-scope-helpers.js";
import { assertSessionEntryPatchAuthority } from "../config/sessions/session-entry-patch-authority.js";
import { captureIncognitoSessionSource } from "../config/sessions/session-incognito-binding.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  classifySessionKeyShape,
  isUnscopedSessionKeySentinel,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import {
  isAgentHarnessSessionKey,
  isAgentHarnessSessionKeyOwnedBy,
  resolveSessionPinnedHarnessId,
} from "../sessions/agent-harness-session-key.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRegistry } from "./registry-types.js";
import type { PluginRuntime } from "./runtime/types.js";

type PluginSessionRuntime = PluginRuntime["agent"]["session"];
type SessionOwnershipFields = Pick<
  SessionEntry,
  "modelSelectionLocked" | "pluginOwnerId" | "agentHarnessId"
>;

const PLUGIN_GATEWAY_SESSION_MUTATION_METHODS = new Set([
  "agent",
  "chat.abort",
  "chat.inject",
  "chat.send",
  "message.action",
  "plugins.sessionAction",
  "send",
  "sessions.abort",
  "sessions.compact",
  "sessions.branches.switch",
  "sessions.rewind",
  "sessions.fork",
  "sessions.create",
  "sessions.delete",
  "sessions.patchMany",
  "sessions.patch",
  "sessions.pluginPatch",
  "sessions.reset",
  "sessions.send",
  "sessions.steer",
  "wake",
]);

const PLUGIN_GATEWAY_GLOBAL_SESSION_MUTATION_METHODS = new Set([
  "sessions.cleanup",
  "sessions.groups.delete",
  "sessions.groups.rename",
]);

/** Session ownership checks loaded only when a plugin invokes an async action. */
export function createPluginSessionOwnership(
  state: PluginRegistryState,
  pluginId: string,
  resolveRegistry: () => PluginRegistry,
  assertRuntimeOwnerCurrent: () => void,
) {
  const { registryParams } = state;
  // SAFETY: Logical session resolution only reads the immutable runtime config snapshot.
  const currentSessionConfig = () => registryParams.runtime.config.current() as OpenClawConfig;
  const requireHarnessRegistration = (value: unknown, action: string) => {
    const harnessId = normalizeOptionalAgentRuntimeId(value);
    if (!harnessId) {
      throw new Error(
        `Plugin "${pluginId}" must provide a registered agent harness id to ${action}.`,
      );
    }
    const registration = resolveRegistry().agentHarnesses.find(
      (entry) => normalizeOptionalAgentRuntimeId(entry.harness.id) === harnessId,
    );
    if (!registration) {
      throw new Error(
        `Plugin "${pluginId}" must register agent harness "${harnessId}" before it can ${action}.`,
      );
    }
    return { harnessId, registration };
  };
  const resolveHarnessRegistrationForSessionKey = (sessionKey: string) =>
    resolveRegistry().agentHarnesses.find((entry) => {
      const rawHarnessId = normalizeOptionalString(entry.harness.id)?.toLowerCase();
      return (
        rawHarnessId === normalizeOptionalAgentRuntimeId(rawHarnessId) &&
        isAgentHarnessSessionKeyOwnedBy(sessionKey, rawHarnessId)
      );
    });
  const assertOwnedHarness = (harnessId: unknown, action: string): string => {
    const { harnessId: normalizedHarnessId, registration } = requireHarnessRegistration(
      harnessId,
      action,
    );
    if (registration.pluginId !== pluginId) {
      throw new Error(
        `Agent harness "${normalizedHarnessId}" is owned by plugin "${registration.pluginId}", not "${pluginId}".`,
      );
    }
    return normalizedHarnessId;
  };
  const assertReservedSessionKeyOwned = (sessionKey: unknown, action: string): void => {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey || !isAgentHarnessSessionKey(normalizedSessionKey)) {
      return;
    }
    const registration = resolveHarnessRegistrationForSessionKey(normalizedSessionKey);
    if (!registration) {
      throw new Error(
        `Plugin "${pluginId}" cannot ${action} reserved agent harness session "${normalizedSessionKey}" because its harness is not registered.`,
      );
    }
    if (registration.pluginId !== pluginId) {
      throw new Error(
        `Plugin "${pluginId}" cannot ${action} reserved agent harness session "${normalizedSessionKey}" owned by plugin "${registration.pluginId}".`,
      );
    }
  };
  const resolveLockedSessionHarnessRegistration = (
    sessionKey: string,
    entry: SessionOwnershipFields,
    action: string,
  ) => {
    if (entry.modelSelectionLocked !== true) {
      return undefined;
    }
    const pluginOwnerId = normalizeOptionalString(entry.pluginOwnerId);
    if (pluginOwnerId) {
      if (isAgentHarnessSessionKey(sessionKey)) {
        throw new Error(
          `Locked session "${sessionKey}" mixes plugin and reserved harness ownership.`,
        );
      }
      return { ownerPluginId: pluginOwnerId };
    }
    const { harnessId, registration } = requireHarnessRegistration(
      resolveSessionPinnedHarnessId(entry),
      `${action} locked sessions`,
    );
    if (
      isAgentHarnessSessionKey(sessionKey) &&
      !isAgentHarnessSessionKeyOwnedBy(sessionKey, harnessId)
    ) {
      throw new Error(
        `Locked session "${sessionKey}" belongs to agent harness "${harnessId}", which does not match its reserved session key.`,
      );
    }
    return { ownerPluginId: registration.pluginId, harnessId, registration };
  };
  const assertLockedSessionEntryOwned = (
    sessionKey: string,
    entry: SessionOwnershipFields,
    action: string,
  ): void => {
    const resolved = resolveLockedSessionHarnessRegistration(sessionKey, entry, action);
    if (!resolved) {
      return;
    }
    if (resolved.ownerPluginId !== pluginId) {
      throw new Error(
        `Locked session "${sessionKey}" is owned by plugin "${resolved.ownerPluginId}", not "${pluginId}".`,
      );
    }
  };
  const assertSessionEntryOwned = (params: {
    action: string;
    entry?: SessionEntry;
    sessionKey: string;
  }): void => {
    if (params.entry) {
      // Before harness locking shipped, plugins could create ordinary sessions
      // whose user-chosen key happened to start with `harness:`.
      assertLockedSessionEntryOwned(params.sessionKey, params.entry, params.action);
      return;
    }
    assertReservedSessionKeyOwned(params.sessionKey, params.action);
  };
  const readOwnershipEntry = (
    params: Parameters<PluginRuntime["agent"]["session"]["getSessionEntry"]>[0],
  ) => {
    const source = captureIncognitoSessionSource(params);
    if (!source) {
      return registryParams.runtime.agent.session.getSessionEntry(params);
    }
    if ("kind" in source) {
      return undefined;
    }
    const key = resolveSqliteSessionKey(params.sessionKey, source.actor.agentId);
    const sharing = source.actor.sessions.readSharing(key)?.entry;
    if (!sharing) {
      return undefined;
    }
    const policy = source.actor.sessions.readCapability(key);
    return {
      ...sharing,
      pluginOwnerId: policy?.pluginOwnerId,
      agentHarnessId: policy?.agentHarnessId,
      agentRuntimeOverride: policy?.agentRuntimeOverride,
    };
  };
  const listOwnershipEntries = (params: { agentId?: string; storePath?: string }) => {
    const ambient = params.storePath ? undefined : captureIncognitoSessionSource();
    const source = captureIncognitoSessionSource(
      ambient
        ? { ...params, storePath: "kind" in ambient ? ambient.path : ambient.actor.path }
        : params,
    );
    if (!source) {
      return registryParams.runtime.agent.session.listSessionEntries({ ...params, readOnly: true });
    }
    if ("kind" in source) {
      return [];
    }
    return source.actor.sessions.deadlines().flatMap(({ sessionKey }) => {
      const entry = readOwnershipEntry({ ...params, sessionKey, storePath: source.actor.path });
      return entry ? [{ sessionKey, entry }] : [];
    });
  };
  const withPreparedSessionOwnership = async <T>(
    params: { agentId?: string; storePath?: string; sessionKey?: string; sessionFile?: string },
    run: () => Promise<T>,
  ): Promise<T> => {
    const marker = params.sessionFile && parseSqliteSessionFileMarker(params.sessionFile);
    const target = marker ? { ...params, ...marker } : params;
    const ambient =
      !target.sessionKey && !target.storePath ? captureIncognitoSessionSource() : undefined;
    const source = captureIncognitoSessionSource(
      ambient
        ? { ...target, storePath: "kind" in ambient ? ambient.path : ambient.actor.path }
        : target,
    );
    if (!source || "kind" in source) {
      return await run();
    }
    return source.actor.sessions.withSharedState(async () => {
      const assertCurrent = () => {
        assertRuntimeOwnerCurrent();
        source.admissionSignal?.throwIfAborted();
        source.actor.assertReadable();
      };
      // Publish exact ownership facts once; final guards consume their live postimages.
      await source.actor.sessions.list(
        { assertCurrent },
        { projection: "list" },
        source.admissionSignal,
      );
      assertCurrent();
      return await run();
    });
  };
  const resolveStoredSessionOwnershipTarget = (params: {
    agentId?: string;
    env?: NodeJS.ProcessEnv;
    sessionKey: string;
    storePath?: string;
  }): { entry?: SessionEntry; sessionKey: string } => {
    if (
      classifySessionKeyShape(params.sessionKey) === "legacy_or_alias" &&
      !isUnscopedSessionKeySentinel(params.sessionKey) &&
      params.agentId === undefined &&
      params.storePath === undefined
    ) {
      // Logical keys need their configured agent before SQLite ownership admission.
      const target = resolveSessionEntryAccessTarget({
        cfg: currentSessionConfig(),
        sessionKey: params.sessionKey,
        ...(params.env !== undefined ? { env: params.env } : {}),
      });
      return { entry: target.entry, sessionKey: target.canonicalKey };
    }
    return {
      entry: readOwnershipEntry({
        sessionKey: params.sessionKey,
        readConsistency: "latest",
        ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
        ...(params.env !== undefined ? { env: params.env } : {}),
        ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
      }),
      sessionKey: params.sessionKey,
    };
  };
  const assertStoredSessionEntryOwned = (params: {
    action: string;
    agentId?: string;
    env?: NodeJS.ProcessEnv;
    sessionKey: string;
    storePath?: string;
  }): SessionEntry | undefined => {
    const target = resolveStoredSessionOwnershipTarget(params);
    assertSessionEntryOwned({ action: params.action, ...target });
    return target.entry;
  };
  const resolveStoredSessionExecutionOwner = (params: {
    action: string;
    agentId?: string;
    sessionKey: string;
    storePath?: string;
  }): string | undefined => {
    const target = resolveStoredSessionOwnershipTarget(params);
    const { entry, sessionKey } = target;
    const locked = entry
      ? resolveLockedSessionHarnessRegistration(sessionKey, entry, params.action)
      : undefined;
    if (!entry || !locked || locked.ownerPluginId === pluginId) {
      assertSessionEntryOwned({ action: params.action, ...target });
      return undefined;
    }
    const registration = "registration" in locked ? locked.registration : undefined;
    if (!registration) {
      throw new Error(
        `Locked session "${sessionKey}" is owned by plugin "${locked.ownerPluginId}", not "${pluginId}".`,
      );
    }
    if (!registration.harness.delegatedExecutionPluginIds?.includes(pluginId)) {
      assertLockedSessionEntryOwned(sessionKey, entry, params.action);
    }
    return locked.ownerPluginId;
  };
  const assertSessionIdentitiesOwned = (params: {
    action: string;
    agentId?: unknown;
    sessionFiles?: unknown[];
    sessionIds?: unknown[];
    sessionKeys?: unknown[];
    storePath?: unknown;
  }): void => {
    const agentId = normalizeOptionalString(params.agentId);
    const storePath = normalizeOptionalString(params.storePath);
    const sessionKeys = new Set(normalizeTrimmedStringList(params.sessionKeys));
    for (const sessionKey of sessionKeys) {
      assertStoredSessionEntryOwned({
        action: params.action,
        sessionKey,
        ...(agentId ? { agentId } : {}),
        ...(storePath ? { storePath } : {}),
      });
    }

    const sessionIds = new Set(normalizeTrimmedStringList(params.sessionIds));
    const sessionFiles = new Set(normalizeTrimmedStringList(params.sessionFiles));
    if (sessionIds.size === 0 && sessionFiles.size === 0) {
      return;
    }
    const entries = listOwnershipEntries({
      ...(agentId ? { agentId } : {}),
      ...(storePath ? { storePath } : {}),
    });
    for (const { sessionKey, entry } of entries) {
      if (sessionIds.has(entry.sessionId)) {
        assertSessionEntryOwned({ action: params.action, entry, sessionKey });
      }
    }
    for (const sessionFile of sessionFiles) {
      const sessionKeyMatches = entries.filter(({ sessionKey }) => sessionKey === sessionFile);
      if (sessionKeyMatches.length > 0) {
        for (const match of sessionKeyMatches) {
          assertSessionEntryOwned({
            action: params.action,
            entry: match.entry,
            sessionKey: match.sessionKey,
          });
        }
        const matchedSessionIds = new Set(
          normalizeTrimmedStringList(sessionKeyMatches.map(({ entry }) => entry.sessionId)),
        );
        for (const match of entries) {
          const matchSessionId = normalizeOptionalString(match.entry.sessionId);
          if (matchSessionId && matchedSessionIds.has(matchSessionId)) {
            assertSessionEntryOwned({
              action: params.action,
              entry: match.entry,
              sessionKey: match.sessionKey,
            });
          }
        }
        continue;
      }
      const marker = parseSqliteSessionFileMarker(sessionFile);
      if (!marker) {
        throw new Error("Plugin session ownership checks require a SQLite transcript marker.");
      }
      const markerEntries = listOwnershipEntries({
        agentId: marker.agentId,
        storePath: marker.storePath,
      });
      const matches = markerEntries.filter(({ entry }) => entry.sessionId === marker.sessionId);
      if (matches.length === 0) {
        throw new Error(`Plugin session ownership target not found: ${marker.sessionId}`);
      }
      for (const match of matches) {
        assertSessionEntryOwned({
          action: params.action,
          entry: match.entry,
          sessionKey: match.sessionKey,
        });
      }
    }
  };
  const prepareRunSessionExecution = (
    params: Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0],
  ): { ownerPluginId?: string; agentHarnessRuntimeOverride?: string } => {
    const target = params.sessionTarget;
    const targetSessionKey = normalizeOptionalString(target?.sessionKey);
    const directSessionKey = normalizeOptionalString(params.sessionKey);
    if (targetSessionKey && directSessionKey && targetSessionKey !== directSessionKey) {
      throw new Error("Delegated agent execution requires one exact session key.");
    }
    const sessionKey = targetSessionKey ?? directSessionKey;
    const storePath = normalizeOptionalString(target?.storePath);
    const agentId = normalizeOptionalString(target?.agentId ?? params.agentId);
    const sessionKeyAgentId = parseAgentSessionKey(sessionKey)?.agentId;
    const normalizedAgentId = agentId ? normalizeAgentId(agentId) : undefined;
    if (sessionKeyAgentId && normalizedAgentId && normalizedAgentId !== sessionKeyAgentId) {
      throw new Error(
        `Plugin session ownership agent "${normalizedAgentId}" does not match session key agent "${sessionKeyAgentId}".`,
      );
    }
    const ownershipAgentId = sessionKeyAgentId ?? normalizedAgentId;
    // Embedded runs accept one exact key. Carry its resolved store into the
    // keyless ID/file scan so incognito ownership stays in the process-held DB.
    const ownershipStorePath =
      sessionKey && sessionKeyAgentId
        ? resolveSessionStorePathForScope({
            agentId: sessionKeyAgentId,
            sessionKey,
            ...(storePath ? { storePath } : {}),
          })
        : storePath;
    const entry = sessionKey
      ? readOwnershipEntry({
          sessionKey,
          readConsistency: "latest",
          ...(agentId ? { agentId } : {}),
          ...(storePath ? { storePath } : {}),
        })
      : undefined;
    const targetSessionId = normalizeOptionalString(target?.sessionId);
    const targetAgentId = normalizeOptionalString(target?.agentId);
    const directSessionId = normalizeOptionalString(params.sessionId);
    const directAgentId = normalizeOptionalString(params.agentId);
    const sessionFile = normalizeOptionalString(params.sessionFile);
    if (target) {
      const legacySessionIdentityMatches =
        Boolean(sessionFile) &&
        Boolean(agentId) &&
        Boolean(storePath) &&
        Boolean(entry?.sessionId) &&
        sqliteSessionFileMarkerMatchesTarget(sessionFile, {
          agentId: agentId!,
          sessionId: entry!.sessionId,
          storePath: storePath!,
        });
      const targetIdentityMatches =
        targetSessionKey === sessionKey &&
        Boolean(storePath) &&
        Boolean(entry) &&
        targetSessionId === entry?.sessionId &&
        directSessionId === entry?.sessionId &&
        targetAgentId === directAgentId &&
        (!sessionFile || sessionFile === sessionKey || legacySessionIdentityMatches);
      if (!targetIdentityMatches) {
        throw new Error(
          `Plugin "${pluginId}" may execute a persisted session only with its exact session target identity.`,
        );
      }
    }
    const locked =
      sessionKey && entry
        ? resolveLockedSessionHarnessRegistration(sessionKey, entry, "run")
        : undefined;
    const ownerPluginId = locked?.ownerPluginId;
    if (locked && entry && sessionKey && ownerPluginId !== pluginId) {
      const registration = "registration" in locked ? locked.registration : undefined;
      if (!registration) {
        throw new Error(
          `Locked session "${sessionKey}" is owned by plugin "${locked.ownerPluginId}", not "${pluginId}".`,
        );
      }
      if (!registration.harness.delegatedExecutionPluginIds?.includes(pluginId)) {
        assertLockedSessionEntryOwned(sessionKey, entry, "run");
      }
      const requestedHarnessId = normalizeOptionalAgentRuntimeId(params.agentHarnessId);
      const requestedRuntimeOverride = normalizeOptionalAgentRuntimeId(
        params.agentHarnessRuntimeOverride,
      );
      const identityMatches =
        Boolean(target) &&
        targetSessionId === entry.sessionId &&
        directSessionId === entry.sessionId;
      const harnessMatches =
        params.modelSelectionLocked === true &&
        requestedHarnessId === locked.harnessId &&
        requestedRuntimeOverride === locked.harnessId;
      if (!identityMatches || !harnessMatches) {
        throw new Error(
          `Plugin "${pluginId}" may execute locked session "${sessionKey}" only with its exact persisted identity and harness.`,
        );
      }
      return { ownerPluginId };
    }
    assertSessionIdentitiesOwned({
      action: "run",
      agentId: ownershipAgentId,
      sessionFiles: [params.sessionFile],
      sessionIds: [target?.sessionId ?? params.sessionId],
      sessionKeys: [target?.sessionKey ?? params.sessionKey],
      storePath: ownershipStorePath,
    });
    // The scan above only observes the key-derived scoped store, so a direct
    // caller-supplied sessionId living in another agent/store passes silently.
    // Fail closed when the key already resolves to a persisted entry whose
    // identity disagrees (see #128327). The target path enforces its own exact
    // identity above, and fresh keys without an entry still create normally.
    if (!target && directSessionId && entry && entry.sessionId !== directSessionId) {
      throw new Error(
        `Plugin "${pluginId}" may execute session "${sessionKey}" only with its exact persisted identity.`,
      );
    }
    // Reuse the authorized snapshot, but never manufacture a native pin or replace
    // a turn-local request (including auto). Detached and raw-model runs own their selection.
    if (
      !entry?.agentRuntimeOverride ||
      params.agentHarnessRuntimeOverride !== undefined ||
      params.sessionPersistence === "detached" ||
      params.modelRun ||
      resolveSessionPinnedHarnessId(entry)
    ) {
      return {};
    }
    const cfg = params.config ?? currentSessionConfig();
    const { provider } = resolveInitialEmbeddedRunModel({
      config: cfg,
      agentId: ownershipAgentId,
      provider: params.provider,
      model: params.model,
    });
    return {
      agentHarnessRuntimeOverride: resolveSessionRuntimeOverrideForProvider({
        provider,
        entry,
        cfg,
      }),
    };
  };
  const assertGatewaySessionRequestOwned = (
    method: string,
    params: Record<string, unknown> | undefined,
  ): void => {
    if (PLUGIN_GATEWAY_GLOBAL_SESSION_MUTATION_METHODS.has(method)) {
      throw new Error(`Plugin "${pluginId}" cannot request global session mutation "${method}".`);
    }
    if (!PLUGIN_GATEWAY_SESSION_MUTATION_METHODS.has(method)) {
      return;
    }
    const request = params ?? {};
    if (method === "sessions.patchMany" && Array.isArray(request.targets)) {
      for (const target of request.targets) {
        if (!isRecord(target)) {
          continue;
        }
        assertSessionIdentitiesOwned({
          action: `request gateway method "${method}" for`,
          agentId: target.agentId,
          sessionKeys: [target.key],
        });
      }
      return;
    }
    const sessionKeys = [request.sessionKey, request.key, request.parentSessionKey];
    const sessionIds = [request.sessionId];
    assertSessionIdentitiesOwned({
      action: `request gateway method "${method}" for`,
      agentId: request.agentId,
      sessionIds,
      sessionKeys,
    });
    if (
      method === "sessions.abort" &&
      !sessionKeys.some((value) => normalizeOptionalString(value)) &&
      !sessionIds.some((value) => normalizeOptionalString(value))
    ) {
      throw new Error(
        `Plugin "${pluginId}" must provide a session key when requesting gateway method "${method}".`,
      );
    }
  };
  const assertStoreEntryOwned = (params: {
    action: string;
    before?: SessionEntry;
    entry: SessionOwnershipFields;
    sessionKey: string;
  }): void => {
    if (params.entry.modelSelectionLocked === true) {
      assertLockedSessionEntryOwned(params.sessionKey, params.entry, params.action);
      return;
    }
    if (params.before?.modelSelectionLocked === true) {
      assertLockedSessionEntryOwned(params.sessionKey, params.before, params.action);
      return;
    }
    if (isAgentHarnessSessionKey(params.sessionKey) && !params.before) {
      assertReservedSessionKeyOwned(params.sessionKey, params.action);
    }
  };
  return {
    withPreparedSessionOwnership,
    createSessionEntry: async (
      session: PluginSessionRuntime,
      params: Parameters<PluginSessionRuntime["createSessionEntry"]>[0],
    ) => {
      const runtimeOwnerCount = [
        "agentHarnessId" in params.initialEntry,
        "cliBackendId" in params.initialEntry,
        "acpSessionBinding" in params.initialEntry,
      ].filter(Boolean).length;
      if (runtimeOwnerCount !== 1) {
        throw new Error(
          `Plugin "${pluginId}" session creation requires exactly one runtime owner.`,
        );
      }
      if ("agentHarnessId" in params.initialEntry) {
        // Session ownership follows the registered harness capability,
        // independently of whether the caller chooses its reserved namespace.
        assertOwnedHarness(params.initialEntry.agentHarnessId, "create its sessions");
        assertReservedSessionKeyOwned(params.key, "create");
        return await session.createSessionEntry(params);
      }
      const initialEntry = params.initialEntry;
      if (!("acpSessionBinding" in initialEntry)) {
        const backend = resolveRegistry().cliBackends.find(
          (entry) => entry.backend.id === initialEntry.cliBackendId,
        );
        if (!backend || backend.pluginId !== pluginId) {
          throw new Error(
            `Plugin "${pluginId}" must own CLI backend "${initialEntry.cliBackendId}" to create its sessions.`,
          );
        }
      }
      // Plugin-owned sessions stay inside a namespace that no other plugin can claim.
      if (!params.key.startsWith(`plugin:${pluginId}:`)) {
        throw new Error(`Plugin "${pluginId}" session keys must start with "plugin:${pluginId}:".`);
      }
      return await session.createSessionEntry({
        ...params,
        initialEntry: { ...initialEntry, pluginOwnerId: pluginId },
      });
    },
    prepareSessionEntryPatch: async (
      session: PluginSessionRuntime,
      params: Parameters<PluginSessionRuntime["prepareSessionEntryPatch"]>[0],
      assertRuntimeCurrent: () => void,
    ) => {
      assertSessionEntryPatchAuthority(params.authority);
      return await session.prepareSessionEntryPatch({
        ...params,
        authority: {
          kind: "source",
          source: composeSessionSourceAssertion(
            [params.authority?.kind === "source" ? params.authority.source : undefined],
            (assertSources) => {
              assertRuntimeCurrent();
              if (params.authority?.kind === "host") {
                params.authority.assertCurrent();
              }
              assertSources();
            },
          ),
        },
        prepare: async (entry, context) => {
          assertStoreEntryOwned({
            action: "patch",
            before: context.existingEntry,
            entry,
            sessionKey: params.sessionKey,
          });
          const patch = await params.prepare(entry, context);
          assertRuntimeCurrent();
          if (patch) {
            assertStoreEntryOwned({
              action: "patch",
              before: context.existingEntry,
              entry: params.replaceEntry ? patch : { ...entry, ...patch },
              sessionKey: params.sessionKey,
            });
          }
          return patch;
        },
      });
    },
    patchSessionEntry: async (
      session: PluginSessionRuntime,
      params: Parameters<PluginSessionRuntime["patchSessionEntry"]>[0],
      assertRuntimeCurrent: () => void,
    ) => {
      assertStoredSessionEntryOwned({ ...params, action: "patch" });
      return await session.patchSessionEntry({
        ...params,
        update: async (entry, context) => {
          const patch = await params.update(entry, context);
          assertRuntimeCurrent();
          if (!patch) {
            return patch;
          }
          const next = params.replaceEntry ? patch : { ...entry, ...patch };
          assertStoreEntryOwned({
            action: "patch",
            before: context.existingEntry ?? entry,
            entry: next,
            sessionKey: params.sessionKey,
          });
          return patch;
        },
      });
    },
    upsertSessionEntry: async (
      session: PluginSessionRuntime,
      params: Parameters<PluginSessionRuntime["upsertSessionEntry"]>[0],
      assertRuntimeCurrent: () => void,
    ) => {
      await session.prepareSessionEntryPatch({
        ...params,
        fallbackEntry: params.entry,
        replaceEntry: true,
        authority: { kind: "host", assertCurrent: assertRuntimeCurrent },
        prepare: (entry, context) => {
          assertStoreEntryOwned({
            action: "upsert",
            before: context.existingEntry,
            entry,
            sessionKey: params.sessionKey,
          });
          assertStoreEntryOwned({
            action: "upsert",
            before: context.existingEntry,
            entry: params.entry,
            sessionKey: params.sessionKey,
          });
          return params.entry;
        },
      });
    },
    prepareSessionStoreUpdate: (
      params: Parameters<PluginSessionRuntime["updateSessionStoreEntry"]>[0],
      assertRuntimeCurrent: () => void,
    ): Parameters<PluginSessionRuntime["updateSessionStoreEntry"]>[0]["update"] => {
      assertStoredSessionEntryOwned({ ...params, action: "update" });
      return async (entry) => {
        const patch = await params.update(entry);
        assertRuntimeCurrent();
        if (!patch) {
          return patch;
        }
        assertStoreEntryOwned({
          action: "update",
          before: entry,
          entry: { ...entry, ...patch },
          sessionKey: params.sessionKey,
        });
        return patch;
      };
    },
    assertStoredSessionEntryOwned,
    resolveStoredSessionExecutionOwner,
    prepareRunSessionExecution,
    assertGatewaySessionRequestOwned,
    assertSessionIdentitiesOwned,
  };
}
