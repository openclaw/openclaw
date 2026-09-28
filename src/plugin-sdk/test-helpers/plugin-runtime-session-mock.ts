import { vi } from "vitest";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

/** One session runtime double shared by plugin fixtures. */
export function createPluginSessionRuntimeMock(): PluginRuntime["agent"]["session"] {
  return {
    readTranscriptAdmission: vi.fn<PluginRuntime["agent"]["session"]["readTranscriptAdmission"]>(
      async () => ({ kind: "missing" }),
    ),
    acceptTranscriptAdmission: vi.fn(async () => ({ kind: "stale" as const })),
    resolveStorePath: vi.fn<PluginRuntime["agent"]["session"]["resolveStorePath"]>(
      () => "/tmp/agent-sessions.json",
    ),
    createSessionEntry: vi.fn(
      async (params: Parameters<PluginRuntime["agent"]["session"]["createSessionEntry"]>[0]) => {
        const sessionId = "plugin-runtime-mock-session";
        const key = params.key;
        const sessionInitialEntry =
          "acpSessionBinding" in params.initialEntry
            ? {
                acpSessionBinding: {
                  acpBackendId: params.initialEntry.acpBackendId,
                  ...params.initialEntry.acpSessionBinding,
                },
                ...(params.initialEntry.modelSelectionLocked
                  ? { modelSelectionLocked: true as const }
                  : {}),
                ...(params.initialEntry.pluginExtensions
                  ? { pluginExtensions: structuredClone(params.initialEntry.pluginExtensions) }
                  : {}),
                ...(params.initialEntry.pluginOwnerId
                  ? { pluginOwnerId: params.initialEntry.pluginOwnerId }
                  : {}),
              }
            : structuredClone(params.initialEntry);
        const initialEntry = {
          sessionId,
          updatedAt: Date.now(),
          ...(params.label !== undefined ? { label: params.label } : {}),
          ...(params.spawnedCwd !== undefined ? { spawnedCwd: params.spawnedCwd } : {}),
          ...sessionInitialEntry,
          ...(params.afterCreate ? { initializationPending: true as const } : {}),
        };
        const initialized = {
          key,
          agentId: params.agentId ?? "main",
          sessionId,
          entry: initialEntry,
        };
        const finalPatch = await params.afterCreate?.(structuredClone(initialized));
        if (finalPatch !== undefined) {
          const patchKeys = Object.keys(finalPatch);
          if (patchKeys.length !== 1 || patchKeys[0] !== "pluginExtensions") {
            throw new Error("session creation final patch may only contain pluginExtensions");
          }
        }
        return {
          ...initialized,
          entry:
            params.afterCreate === undefined
              ? initialEntry
              : {
                  ...initialEntry,
                  ...(finalPatch === undefined
                    ? {}
                    : {
                        pluginExtensions: structuredClone(finalPatch.pluginExtensions),
                      }),
                  initializationPending: undefined,
                },
        };
      },
    ) as PluginRuntime["agent"]["session"]["createSessionEntry"],
    getSessionEntry: vi.fn<PluginRuntime["agent"]["session"]["getSessionEntry"]>(() => undefined),
    listSessionEntries: vi.fn<PluginRuntime["agent"]["session"]["listSessionEntries"]>(() => []),
    patchSessionEntry: vi
      .fn<PluginRuntime["agent"]["session"]["patchSessionEntry"]>()
      .mockResolvedValue(null),
    upsertSessionEntry: vi
      .fn<PluginRuntime["agent"]["session"]["upsertSessionEntry"]>()
      .mockResolvedValue(undefined),
    runWithWorkAdmission: vi.fn(
      async (_params, run) => await run(new AbortController().signal),
    ) as PluginRuntime["agent"]["session"]["runWithWorkAdmission"],
    updateSessionStoreEntry: vi
      .fn<PluginRuntime["agent"]["session"]["updateSessionStoreEntry"]>()
      .mockResolvedValue(null),
  };
}
