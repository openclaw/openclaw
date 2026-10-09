import type { SessionEntry } from "../config/sessions/types.js";
import { isPluginRecordActive } from "./registry-lifecycle.js";
import type { createPluginSessionOwnership } from "./registry-runtime-session-ownership.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import type { PluginRuntime } from "./runtime/types.js";

/** One namespace projection belongs to its runtime source, not the invocation reading it. */
export function createRuntimeFacade<T>() {
  let cached: { source: T; value: T } | undefined;
  return (source: T, project: (source: T) => T): T => {
    if (cached && cached.source === source) {
      return cached.value;
    }
    const value = project(source);
    cached = { source, value };
    return value;
  };
}

/** Agent projections retain one source facade while delegating authority to the registry owner. */
export function createPluginAgentRuntimeFacade({
  registry,
  record,
  pluginId,
  currentRegistry,
  resolveDelegatedRuntime,
  assertRuntimeCurrent,
  runWithPluginScope,
  invokeSelectedRuntime,
  loadSessionOwnership,
}: {
  registry: PluginRegistry;
  record: PluginRecord;
  pluginId: string;
  currentRegistry: () => PluginRegistry;
  resolveDelegatedRuntime: (ownerPluginId: string) => PluginRuntime;
  assertRuntimeCurrent: () => void;
  runWithPluginScope: <T>(run: () => T) => T;
  invokeSelectedRuntime: <T>(run: () => T) => T;
  loadSessionOwnership: () => Promise<ReturnType<typeof createPluginSessionOwnership>>;
}) {
  let scopedAgentRuntime:
    | { source: PluginRuntime["agent"]; value: PluginRuntime["agent"] }
    | undefined;
  return (agent: PluginRuntime["agent"]): PluginRuntime["agent"] => {
    if (scopedAgentRuntime?.source === agent) {
      return scopedAgentRuntime.value;
    }
    const session = agent.session;
    const scopedSession = {
      resolveStorePath: session.resolveStorePath,
      getSessionEntry: session.getSessionEntry,
      listSessionEntries: session.listSessionEntries,
      createSessionEntry: async (params) => {
        const { assertOwnedHarness, assertReservedSessionKeyOwned } = await loadSessionOwnership();
        return await runWithPluginScope(async () => {
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
            const backend = currentRegistry().cliBackends.find(
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
            throw new Error(
              `Plugin "${pluginId}" session keys must start with "plugin:${pluginId}:".`,
            );
          }
          return await session.createSessionEntry({
            ...params,
            initialEntry: { ...initialEntry, pluginOwnerId: pluginId },
          });
        });
      },
      patchSessionEntry: async (params) => {
        const { assertStoredSessionEntryOwned, assertStoreEntryOwned } =
          await loadSessionOwnership();
        return await runWithPluginScope(async () => {
          assertStoredSessionEntryOwned({
            action: "patch",
            sessionKey: params.sessionKey,
            ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
            ...(params.env !== undefined ? { env: params.env } : {}),
            ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
          });
          return await session.patchSessionEntry({
            ...params,
            update: async (entry, context) => {
              const patch = await params.update(entry, context);
              assertRuntimeCurrent();
              if (!patch) {
                return patch;
              }
              const next = params.replaceEntry
                ? (patch as SessionEntry) // SAFETY: replaceEntry supplies the whole entry; the host store still validates it before writing.
                : ({ ...entry, ...patch } satisfies SessionEntry);
              assertStoreEntryOwned({
                action: "patch",
                before: context.existingEntry ?? entry,
                entry: next,
                sessionKey: params.sessionKey,
              });
              return patch;
            },
          });
        });
      },
      upsertSessionEntry: async (params) => {
        const { assertStoredSessionEntryOwned, assertStoreEntryOwned } =
          await loadSessionOwnership();
        return await runWithPluginScope(async () => {
          const before = assertStoredSessionEntryOwned({
            action: "upsert",
            sessionKey: params.sessionKey,
            ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
            ...(params.env !== undefined ? { env: params.env } : {}),
            ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
          });
          assertStoreEntryOwned({
            action: "upsert",
            before,
            entry: params.entry,
            sessionKey: params.sessionKey,
          });
          await session.upsertSessionEntry(params);
        });
      },
      runWithWorkAdmission: async (params, run) => {
        const { resolveStoredSessionExecutionOwner } = await loadSessionOwnership();
        return await runWithPluginScope(async () => {
          const resolveCurrentExecutionOwner = () =>
            resolveStoredSessionExecutionOwner({
              action: "admit work on",
              sessionKey: params.sessionKey,
              storePath: params.storePath,
            });
          const ownerPluginId = resolveCurrentExecutionOwner();
          const admissionSession = ownerPluginId
            ? resolveDelegatedRuntime(ownerPluginId).agent.session
            : session;
          return await admissionSession.runWithWorkAdmission(params, async (signal) => {
            // Admission can wait behind another run that changes ownership.
            // Recheck delegation inside the admitted callback before plugin work starts.
            if (resolveCurrentExecutionOwner() !== ownerPluginId) {
              throw new Error(
                `Session "${params.sessionKey}" changed execution ownership while starting work.`,
              );
            }
            // The owner supplies the admission primitive, but the caller's
            // callback must not inherit the owner's plugin identity.
            return await runWithPluginScope(() => run(signal));
          });
        });
      },
      updateSessionStoreEntry: async (params) => {
        const { assertStoredSessionEntryOwned, assertStoreEntryOwned } =
          await loadSessionOwnership();
        return await runWithPluginScope(async () => {
          assertStoredSessionEntryOwned({
            action: "update",
            sessionKey: params.sessionKey,
            storePath: params.storePath,
          });
          return await session.updateSessionStoreEntry({
            ...params,
            update: async (entry) => {
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
            },
          });
        });
      },
    } satisfies PluginRuntime["agent"]["session"];
    const runEmbeddedAgent: PluginRuntime["agent"]["runEmbeddedAgent"] = async (params) => {
      const runParams = { ...params };
      const { prepareRunSessionExecution } = await loadSessionOwnership();
      return await runWithPluginScope(async () => {
        const { ownerPluginId, agentHarnessRuntimeOverride } =
          prepareRunSessionExecution(runParams);
        if (agentHarnessRuntimeOverride !== undefined) {
          runParams.agentHarnessRuntimeOverride = agentHarnessRuntimeOverride;
        }
        if (ownerPluginId) {
          return await resolveDelegatedRuntime(ownerPluginId).agent.runEmbeddedAgent(runParams);
        }
        // The public runtime adapter owns admission preparation. Passing
        // host authority through this plugin wrapper is rejected by design.
        return await agent.runEmbeddedAgent(runParams);
      });
    };
    const runCommandFromIngress: PluginRuntime["agent"]["runCommandFromIngress"] = async (
      params,
      commandRuntime,
    ) => {
      const { senderIsOwner: claimedOwner, messageChannel, ...remainingParams } = params;
      const senderIsOwner = claimedOwner === true;
      // Validate and dispatch the same host-owned values; never re-read plugin-owned authority.
      const ingressParams = { ...remainingParams, senderIsOwner, messageChannel };
      if (
        // Community channels may admit guests; trusted provenance is required only for owner elevation.
        (senderIsOwner && record.origin !== "bundled" && record.trustedOfficialInstall !== true) ||
        currentRegistry().plugins.find((entry) => entry.id === pluginId) !== record ||
        !isPluginRecordActive(registry, record) ||
        !currentRegistry().channels.some(
          (channel) => channel.pluginId === pluginId && channel.plugin.id === messageChannel,
        )
      ) {
        throw new Error(
          `Plugin "${pluginId}" cannot admit authenticated owner authority for channel "${messageChannel ?? "unknown"}".`,
        );
      }
      return await runWithPluginScope(() =>
        agent.runCommandFromIngress(ingressParams, commandRuntime),
      );
    };
    const scopedAgent = Object.create(
      Object.getPrototypeOf(agent),
      Object.getOwnPropertyDescriptors(agent),
    ) as PluginRuntime["agent"]; // SAFETY: The source prototype and every property descriptor are preserved from the typed agent runtime.
    Object.defineProperties(scopedAgent, {
      resolveThinkingDefault: {
        configurable: true,
        enumerable: true,
        value: (params: Parameters<typeof agent.resolveThinkingDefault>[0]) =>
          invokeSelectedRuntime(() => agent.resolveThinkingDefault(params)),
      },
      resolveCliBackendDispatchEligibility: {
        configurable: true,
        enumerable: true,
        value: (params: Parameters<typeof agent.resolveCliBackendDispatchEligibility>[0]) =>
          invokeSelectedRuntime(() => agent.resolveCliBackendDispatchEligibility(params)),
      },
      resolveSessionCatalogCreateTarget: {
        configurable: true,
        enumerable: true,
        value: (params: Parameters<typeof agent.resolveSessionCatalogCreateTarget>[0]) =>
          invokeSelectedRuntime(() => agent.resolveSessionCatalogCreateTarget(params)),
      },
      resolveThinkingPolicy: {
        configurable: true,
        enumerable: true,
        value: (params: Parameters<typeof agent.resolveThinkingPolicy>[0]) =>
          invokeSelectedRuntime(() => agent.resolveThinkingPolicy(params)),
      },
      runCommandFromIngress: {
        configurable: true,
        enumerable: true,
        value: runCommandFromIngress,
      },
      runEmbeddedAgent: {
        configurable: true,
        enumerable: true,
        value: runEmbeddedAgent,
      },
      session: {
        configurable: true,
        enumerable: true,
        value: scopedSession,
      },
    });
    scopedAgentRuntime = { source: agent, value: scopedAgent };
    return scopedAgent;
  };
}
