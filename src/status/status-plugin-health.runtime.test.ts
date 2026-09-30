// Runtime plugin health tests cover state shared across runtime processes.
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { recordPersistedRuntimeToolSchemaQuarantine } from "../agents/tool-schema-quarantine-health.js";
import { resolveReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import {
  clearPersistedContextEngineQuarantineForProcess,
  recordPersistedContextEngineQuarantine,
} from "../context-engine/quarantine-health.js";
import { resetContextEngineRuntimeQuarantineForTests } from "../context-engine/registry.test-support.js";
import {
  createCorePluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import * as pluginStateWorker from "../plugin-state/plugin-state-worker-client.js";
import { createRuntimeHealthRecordEnvelope } from "../plugin-state/runtime-health-store.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { collectRuntimePluginHealthSnapshot } from "./status-plugin-health.runtime.js";

vi.mock("../channels/plugins/read-only.js", () => ({
  resolveReadOnlyChannelPluginsForConfig: vi.fn(),
}));

const resolveReadOnlyChannelPluginsForConfigMock = vi.mocked(
  resolveReadOnlyChannelPluginsForConfig,
);

afterEach(() => {
  resolveReadOnlyChannelPluginsForConfigMock.mockReset();
  resetPluginRuntimeStateForTest();
  resetPluginStateStoreForTests();
});

async function deadProcessId(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  if (!pid) {
    throw new Error("failed to spawn short-lived process");
  }
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  return pid;
}

function seedPersistedToolQuarantineForTest(record: {
  toolName: string;
  owner?: string;
  reason: string;
  failedAtMs: number;
  processId: number;
  processToken: string;
  processStartTime: number | null;
}): void {
  createCorePluginStateSyncKeyedStore<typeof record>({
    ownerId: "core:runtime-tool-quarantine-health",
    namespace: "schema-quarantines",
    maxEntries: 128,
    defaultTtlMs: 24 * 60 * 60 * 1_000,
  }).register(JSON.stringify([record.owner ?? "", record.toolName, record.processId]), record);
}

describe("runtime plugin health snapshot", () => {
  it.each(["clear", "replace"] as const)(
    "settles an overlapping snapshot and observes %s on the next read",
    async (change) => {
      await withStateDirEnv("openclaw-status-quarantine-recovery-", async () => {
        resetContextEngineRuntimeQuarantineForTests();
        const quarantine = {
          engineId: "recovered-engine",
          operation: "bootstrap",
          reason: "temporary failure",
          failedAt: new Date(123),
        };
        recordPersistedContextEngineQuarantine(quarantine);
        recordPersistedRuntimeToolSchemaQuarantine({
          toolName: "still-quarantined-tool",
          reason: "unsupported schema",
          failedAt: new Date(456),
        });
        const captured = createDeferredCore<unknown>();
        const release = createDeferredCore();
        const listEntries = pluginStateWorker.listPluginStateInWorker;
        let held = false;
        const observation = vi
          .spyOn(pluginStateWorker, "listPluginStateInWorker")
          .mockImplementation(async (params) => {
            const entries = await listEntries(params);
            if (params.namespace === "runtime-quarantines" && !held) {
              held = true;
              captured.resolve(entries);
              await release.promise;
            }
            return entries;
          });
        const pending = collectRuntimePluginHealthSnapshot();
        try {
          expect(await captured.promise).toEqual([
            expect.objectContaining({
              value: expect.objectContaining({ engineId: "recovered-engine" }),
            }),
          ]);
          clearPersistedContextEngineQuarantineForProcess("recovered-engine", process.pid);
          const replacement = { ...quarantine, reason: "new failure", failedAt: new Date(789) };
          if (change === "replace") {
            recordPersistedContextEngineQuarantine(replacement);
          }
          release.resolve();
          const snapshot = await pending;
          expect(snapshot.contextEngineQuarantines).toEqual([quarantine]);
          expect(snapshot.runtimeToolQuarantines).toEqual([
            {
              toolName: "still-quarantined-tool",
              reason: "unsupported schema",
              failedAt: new Date(456),
            },
          ]);
          const nextSnapshot = await collectRuntimePluginHealthSnapshot();
          expect(nextSnapshot.contextEngineQuarantines).toEqual(
            change === "replace" ? [replacement] : [],
          );
        } finally {
          release.resolve();
          await pending;
          observation.mockRestore();
        }
      });
    },
  );

  it("includes persisted context-engine quarantines without caller-thread SQLite", async () => {
    await withStateDirEnv("openclaw-status-plugin-health-", async () => {
      resetContextEngineRuntimeQuarantineForTests();
      recordPersistedContextEngineQuarantine({
        engineId: "lossless-claw",
        owner: "plugin:lossless-claw",
        operation: "bootstrap",
        reason: "intentional bootstrap failure",
        failedAt: new Date(123),
      });

      const observation = observeHostDataSql();
      let snapshot;
      try {
        snapshot = await collectRuntimePluginHealthSnapshot();
        expect(observation.queries).toEqual([]);
      } finally {
        observation.restore();
      }
      expect(snapshot.contextEngineQuarantines).toEqual([
        {
          engineId: "lossless-claw",
          owner: "plugin:lossless-claw",
          operation: "bootstrap",
          reason: "intentional bootstrap failure",
          failedAt: new Date(123),
        },
      ]);
    });
  });

  it("includes core-owned runtime tool quarantines from this process", async () => {
    await withStateDirEnv("openclaw-status-tool-quarantine-core-", async () => {
      setActivePluginRegistry(createEmptyPluginRegistry(), "empty", "default", "/tmp/ws");
      recordPersistedRuntimeToolSchemaQuarantine({
        toolName: "core_bad_tool",
        reason: "unsupported schema",
        failedAt: new Date(789),
      });

      expect((await collectRuntimePluginHealthSnapshot()).runtimeToolQuarantines).toEqual([
        {
          toolName: "core_bad_tool",
          reason: "unsupported schema",
          failedAt: new Date(789),
        },
      ]);
    });
  });

  it("drops runtime tool quarantines from dead or unverifiable recorder processes", async () => {
    await withStateDirEnv("openclaw-status-tool-quarantine-liveness-", async () => {
      setActivePluginRegistry(createEmptyPluginRegistry(), "empty", "default", "/tmp/ws");
      // Dead sibling: no current start time exists, so the record fails closed.
      seedPersistedToolQuarantineForTest({
        toolName: "stale_tool",
        reason: "unsupported schema",
        failedAtMs: 123,
        processId: await deadProcessId(),
        processToken: "dead-process-token",
        processStartTime: null,
      });
      seedPersistedToolQuarantineForTest({
        toolName: "live_tool",
        reason: "unsupported schema",
        ...createRuntimeHealthRecordEnvelope(new Date(456)),
      });

      expect((await collectRuntimePluginHealthSnapshot()).runtimeToolQuarantines).toEqual([
        {
          toolName: "live_tool",
          reason: "unsupported schema",
          failedAt: new Date(456),
        },
      ]);
    });
  });

  it("drops runtime tool quarantines from a previous incarnation of this PID", async () => {
    await withStateDirEnv("openclaw-status-tool-quarantine-pid-reuse-", async () => {
      setActivePluginRegistry(createEmptyPluginRegistry(), "empty", "default", "/tmp/ws");
      seedPersistedToolQuarantineForTest({
        toolName: "reused_pid_tool",
        reason: "unsupported schema",
        ...createRuntimeHealthRecordEnvelope(new Date(123)),
        processToken: "stale-incarnation-token",
      });

      expect((await collectRuntimePluginHealthSnapshot()).runtimeToolQuarantines).toEqual([]);
    });
  });

  it("suppresses persisted plugin-owned runtime tool quarantines after the owner plugin is gone", async () => {
    await withStateDirEnv("openclaw-status-tool-quarantine-owner-", async () => {
      recordPersistedRuntimeToolSchemaQuarantine({
        toolName: "bad_tool",
        owner: "plugin:bad-tools",
        reason: "unsupported anyOf",
        failedAt: new Date(456),
      });

      setActivePluginRegistry(createEmptyPluginRegistry(), "empty", "default", "/tmp/ws");
      expect((await collectRuntimePluginHealthSnapshot()).runtimeToolQuarantines).toEqual([]);

      const registry = createEmptyPluginRegistry();
      registry.plugins.push({
        id: "bad-tools",
        status: "loaded",
        enabled: true,
      } as never);
      setActivePluginRegistry(registry, "bad-tools", "default", "/tmp/ws");

      expect((await collectRuntimePluginHealthSnapshot()).runtimeToolQuarantines).toEqual([
        {
          toolName: "bad_tool",
          owner: "plugin:bad-tools",
          reason: "unsupported anyOf",
          failedAt: new Date(456),
        },
      ]);
    });
  });

  it("does not inspect configured channel plugins for compact runtime health", async () => {
    const registry = createEmptyPluginRegistry();
    registry.diagnostics.push({
      level: "error",
      pluginId: "broken-channel",
      code: "channel-setup-failure",
      message: "failed to load setup entry: boom",
    });
    setActivePluginRegistry(registry, "broken-channel", "default", "/tmp/ws");

    const snapshot = await collectRuntimePluginHealthSnapshot();

    expect(snapshot.channelPluginFailures).toEqual([
      {
        channelId: "broken-channel",
        pluginId: "broken-channel",
        message: "failed to load setup entry: boom",
        source: "diagnostic",
      },
    ]);
    expect(resolveReadOnlyChannelPluginsForConfigMock).not.toHaveBeenCalled();
  });

  it("records only runtime status:loaded plugins as runtime-loaded", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      { id: "runtime-ok", status: "loaded", enabled: true } as never,
      { id: "runtime-broken", status: "error", enabled: true } as never,
      { id: "runtime-off", status: "disabled", enabled: false } as never,
    );
    setActivePluginRegistry(registry, "runtime-loaded-ids", "default", "/tmp/ws");

    expect((await collectRuntimePluginHealthSnapshot()).runtimeLoadedPluginIds).toEqual([
      "runtime-ok",
    ]);
  });
});
