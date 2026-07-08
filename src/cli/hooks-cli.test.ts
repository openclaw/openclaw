// Hooks CLI tests cover hook command registration and output behavior.
import { describe, expect, it } from "vitest";
import type { HookStatusReport } from "../hooks/hooks-status.js";
import {
  formatHookInfo,
  formatHookQueueItems,
  formatHookQueuesList,
  formatHookQueueState,
  formatHooksCheck,
  formatHooksList,
} from "./hooks-cli.js";
import { createEmptyInstallChecks } from "./requirements-test-fixtures.js";

const report: HookStatusReport = {
  workspaceDir: "/tmp/workspace",
  managedHooksDir: "/tmp/hooks",
  hooks: [
    {
      name: "session-memory",
      description: "Save session context to memory",
      source: "openclaw-bundled",
      pluginId: undefined,
      filePath: "/tmp/hooks/session-memory/HOOK.md",
      baseDir: "/tmp/hooks/session-memory",
      handlerPath: "/tmp/hooks/session-memory/handler.js",
      hookKey: "session-memory",
      emoji: "💾",
      homepage: "https://docs.openclaw.ai/automation/hooks#session-memory",
      events: ["command:new"],
      unknownEvents: [],
      always: false,
      enabledByConfig: true,
      requirementsSatisfied: true,
      loadable: true,
      blockedReason: undefined,
      managedByPlugin: false,
      ...createEmptyInstallChecks(),
    },
  ],
};

function createPluginManagedHookReport(): HookStatusReport {
  return {
    workspaceDir: "/tmp/workspace",
    managedHooksDir: "/tmp/hooks",
    hooks: [
      {
        name: "plugin-hook",
        description: "Hook from plugin",
        source: "openclaw-plugin",
        pluginId: "voice-call",
        filePath: "/tmp/hooks/plugin-hook/HOOK.md",
        baseDir: "/tmp/hooks/plugin-hook",
        handlerPath: "/tmp/hooks/plugin-hook/handler.js",
        hookKey: "plugin-hook",
        emoji: "🔗",
        homepage: undefined,
        events: ["command:new"],
        unknownEvents: [],
        always: false,
        enabledByConfig: true,
        requirementsSatisfied: true,
        loadable: true,
        blockedReason: undefined,
        managedByPlugin: true,
        ...createEmptyInstallChecks(),
      },
    ],
  };
}

describe("hooks cli formatting", () => {
  it("labels hooks list output", () => {
    const output = formatHooksList(report, {});
    expect(output).toContain("Hooks");
    expect(output).not.toContain("Internal Hooks");
  });

  it("labels hooks status output", () => {
    const output = formatHooksCheck(report, {});
    expect(output).toContain("Hooks Status");
  });

  it("labels plugin-managed hooks with plugin id", () => {
    const pluginReport = createPluginManagedHookReport();

    const output = formatHooksList(pluginReport, {});
    expect(output).toContain("plugin:voice-call");
  });

  it("warns about unknown events in hook info", () => {
    const typoReport: HookStatusReport = {
      workspaceDir: "/tmp/workspace",
      managedHooksDir: "/tmp/hooks",
      hooks: [
        {
          ...report.hooks[0],
          name: "typo-hook",
          events: ["command:nwe", "command:new"],
          unknownEvents: ["command:nwe"],
        },
      ],
    };

    const output = formatHookInfo(typoReport, "typo-hook", {});
    expect(output).toContain("Event not emitted by core (likely typo): command:nwe");
  });

  it("shows plugin-managed details in hook info", () => {
    const pluginReport = createPluginManagedHookReport();

    const output = formatHookInfo(pluginReport, "plugin-hook", {});
    expect(output).toContain("voice-call");
    expect(output).toContain("Managed by plugin");
  });

  it("formats hook queue summaries with pause state", () => {
    const output = formatHookQueuesList(
      {
        queues: [
          {
            id: "bulk",
            path: "/hooks/queue/bulk",
            parallelism: 10,
            sessionTarget: "isolated",
            paused: true,
            pausedAtMs: 1_000,
            counts: { queued: 42, running: 10, ok: 7, error: 1 },
          },
        ],
      },
      {},
    );

    expect(output).toContain("Hook Queues");
    expect(output).toContain("bulk");
    expect(output).toContain("paused");
    expect(output).toContain("42");
  });

  it("formats hook queue item inspection", () => {
    const output = formatHookQueueItems(
      "bulk",
      {
        total: 1,
        items: [
          {
            itemId: "item-1",
            queueId: "bulk",
            status: "queued",
            runId: "run-1",
            sourcePath: "/hooks/queue/bulk",
            name: "Import",
            message: "Import record",
            messagePreview: "Import record",
            sessionKey: "hook:bulk",
            sessionTarget: "isolated",
            createdAtMs: 1_000,
            updatedAtMs: 2_000,
          },
        ],
      },
      {},
    );

    expect(output).toContain("Hook Queue Items");
    expect(output).toContain("item-1");
    expect(output).toContain("Import record");
  });

  it("formats hook queue pause and resume state", () => {
    expect(
      formatHookQueueState(
        { queueId: "bulk", paused: true, pausedAtMs: 1_000, updatedAtMs: 1_000 },
        {},
      ),
    ).toContain("paused");
    expect(
      formatHookQueueState(
        {
          queueId: "bulk",
          paused: false,
          pausedAtMs: null,
          updatedAtMs: 2_000,
        },
        {},
      ),
    ).toContain("running");
  });
});
