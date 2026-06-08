// Runtime plugin health tests cover state shared across runtime processes.
import { afterEach, describe, expect, it } from "vitest";
import {
  clearPersistedRuntimeToolSchemaQuarantinesForProcess,
  recordPersistedRuntimeToolSchemaQuarantine,
} from "../agents/tool-schema-quarantine-health.js";
import { recordPersistedContextEngineQuarantine } from "../context-engine/quarantine-health.js";
import { clearContextEngineRuntimeQuarantine } from "../context-engine/registry.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { collectRuntimePluginHealthSnapshot } from "./status-plugin-health.runtime.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("runtime plugin health snapshot", () => {
  it("includes persisted context-engine quarantines", async () => {
    await withStateDirEnv("openclaw-status-plugin-health-", async () => {
      clearContextEngineRuntimeQuarantine();
      recordPersistedContextEngineQuarantine({
        engineId: "lossless-claw",
        owner: "plugin:lossless-claw",
        operation: "bootstrap",
        reason: "intentional bootstrap failure",
        failedAt: new Date(123),
      });

      expect(collectRuntimePluginHealthSnapshot().contextEngineQuarantines).toEqual([
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

  it("includes persisted runtime tool-schema quarantines", async () => {
    await withStateDirEnv("openclaw-status-tool-quarantine-", async () => {
      clearPersistedRuntimeToolSchemaQuarantinesForProcess();
      const registry = createEmptyPluginRegistry();
      registry.plugins.push({
        id: "bad-tools",
        status: "loaded",
        enabled: true,
      } as never);
      setActivePluginRegistry(registry, "bad-tools", "default", "/tmp/ws");
      recordPersistedRuntimeToolSchemaQuarantine({
        toolName: "bad_tool",
        owner: "plugin:bad-tools",
        reason: "unsupported anyOf",
        failedAt: new Date(456),
        runId: "run-test",
      });

      expect(collectRuntimePluginHealthSnapshot().runtimeToolQuarantines).toEqual([
        {
          toolName: "bad_tool",
          owner: "plugin:bad-tools",
          reason: "unsupported anyOf",
          failedAt: new Date(456),
          runId: "run-test",
        },
      ]);
    });
  });

  it("keeps runtime tool-schema quarantine records independent of source process liveness", async () => {
    await withStateDirEnv("openclaw-status-tool-quarantine-core-", async () => {
      clearPersistedRuntimeToolSchemaQuarantinesForProcess();
      setActivePluginRegistry(createEmptyPluginRegistry(), "empty", "default", "/tmp/ws");
      recordPersistedRuntimeToolSchemaQuarantine({
        toolName: "core_bad_tool",
        reason: "unsupported schema",
        failedAt: new Date(789),
        runId: "run-core-test",
      });

      expect(collectRuntimePluginHealthSnapshot().runtimeToolQuarantines).toEqual([
        {
          toolName: "core_bad_tool",
          reason: "unsupported schema",
          failedAt: new Date(789),
          runId: "run-core-test",
        },
      ]);
    });
  });

  it("suppresses persisted plugin-owned runtime tool quarantines after the owner plugin is gone", async () => {
    await withStateDirEnv("openclaw-status-tool-quarantine-owner-", async () => {
      clearPersistedRuntimeToolSchemaQuarantinesForProcess();
      recordPersistedRuntimeToolSchemaQuarantine({
        toolName: "bad_tool",
        owner: "plugin:bad-tools",
        reason: "unsupported anyOf",
        failedAt: new Date(456),
        runId: "run-plugin-test",
      });

      setActivePluginRegistry(createEmptyPluginRegistry(), "empty", "default", "/tmp/ws");
      expect(collectRuntimePluginHealthSnapshot().runtimeToolQuarantines).toEqual([]);

      const registry = createEmptyPluginRegistry();
      registry.plugins.push({
        id: "bad-tools",
        status: "loaded",
        enabled: true,
      } as never);
      setActivePluginRegistry(registry, "bad-tools", "default", "/tmp/ws");

      expect(collectRuntimePluginHealthSnapshot().runtimeToolQuarantines).toEqual([
        {
          toolName: "bad_tool",
          owner: "plugin:bad-tools",
          reason: "unsupported anyOf",
          failedAt: new Date(456),
          runId: "run-plugin-test",
        },
      ]);
    });
  });

  it("classifies setup-channel diagnostics as channel plugin failures", () => {
    const registry = createEmptyPluginRegistry();
    registry.diagnostics.push({
      level: "error",
      pluginId: "broken-channel",
      message: "failed to load setup entry: boom",
    } as never);
    setActivePluginRegistry(registry, "broken-channel", "default", "/tmp/ws");

    const snapshot = collectRuntimePluginHealthSnapshot();

    expect(snapshot.channelPluginFailures).toEqual([
      {
        channelId: "broken-channel",
        pluginId: "broken-channel",
        message: "failed to load setup entry: boom",
        source: "diagnostic",
      },
    ]);
  });
});
