import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../commands/doctor-memory-recall.js";
import "../commands/doctor-memory-search.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { saveCronStore } from "../cron/store.js";
import { appendMemoryHostEvent } from "../memory-host-sdk/events.js";
import { clearPluginRegistryLoadCache } from "../plugins/loader.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { runMemorySearchHealthContribution } from "./doctor-health-contribution-runners.workspace.js";
import { createDoctorHealthFlowContext } from "./doctor-health-contributions.test-support.js";

const { note, getManager, getBackend } = vi.hoisted(() => ({
  note: vi.fn(),
  getManager: vi.fn(() => {
    throw new Error("ordinary Doctor must not open a memory manager");
  }),
  getBackend: vi.fn(() => {
    throw new Error("ordinary Doctor must not load the memory runtime");
  }),
}));

vi.mock("../../packages/terminal-core/src/note.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/terminal-core/src/note.js")>();
  return { ...actual, note };
});
vi.mock("../plugins/memory-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/memory-runtime.js")>();
  return {
    ...actual,
    getActiveMemorySearchManagerCore: getManager,
    resolveActiveMemoryBackendConfig: getBackend,
  };
});

describe("ordinary Doctor memory output", () => {
  let root: string;
  let imported: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-memory-output-"));
    imported = path.join(root, "plugin-imported");
    for (const id of ["memory-core", "memory-provider"]) {
      const dir = path.join(root, "bundled", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "openclaw.plugin.json"),
        JSON.stringify({ id, kind: "memory", configSchema: { type: "object" } }),
      );
      fs.writeFileSync(
        path.join(dir, "index.js"),
        `require("node:fs").writeFileSync(${JSON.stringify(imported)}, "imported");`,
      );
      if (id === "memory-core") {
        fs.writeFileSync(
          path.join(dir, "dreaming-status-api.js"),
          `module.exports = require(${JSON.stringify(path.resolve("extensions/memory-core/dreaming-status-api.ts"))});`,
        );
      }
    }
  });

  beforeEach(() => {
    note.mockClear();
    getManager.mockClear();
    getBackend.mockClear();
    clearPluginRegistryLoadCache();
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(root, "bundled"));
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
    vi.stubEnv("OPENCLAW_SKIP_CRON", undefined);
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it.each<{
    label: string;
    plugins: OpenClawConfig["plugins"];
    enabled: boolean;
  }>([
    { label: "default memory plugin", plugins: {}, enabled: true },
    {
      label: "disabled dreaming",
      plugins: {
        entries: {
          "memory-core": { config: { dreaming: { enabled: false, frequency: "0 */4 * * *" } } },
        },
      },
      enabled: false,
    },
    { label: "globally disabled plugins", plugins: { enabled: false }, enabled: false },
    {
      label: "disabled memory plugin",
      plugins: {
        entries: {
          "memory-core": {
            enabled: false,
            config: { dreaming: { enabled: true, frequency: "0 */4 * * *" } },
          },
        },
      },
      enabled: false,
    },
    { label: "denied memory plugin", plugins: { deny: ["memory-core"] }, enabled: false },
    { label: "disabled memory slot", plugins: { slots: { memory: "none" } }, enabled: false },
    {
      label: "provider dreaming sidecar with restrictive allowlist",
      plugins: {
        allow: ["memory-provider"],
        slots: { memory: "memory-provider" },
        entries: {
          "memory-core": {
            enabled: true,
            config: { dreaming: { enabled: false, frequency: "0 */12 * * *" } },
          },
          "memory-provider": {
            enabled: true,
            config: { dreaming: { enabled: true, frequency: "0 */4 * * *" } },
          },
        },
      },
      enabled: true,
    },
    {
      label: "disabled selected provider",
      plugins: {
        slots: { memory: "memory-provider" },
        entries: {
          "memory-provider": {
            enabled: false,
            config: { dreaming: { enabled: true, frequency: "0 */4 * * *" } },
          },
        },
      },
      enabled: false,
    },
  ])(
    "reports effective dreaming for $label without loading plugins",
    async ({ plugins, enabled }) => {
      const ctx = createDoctorHealthFlowContext({
        cfg: {
          agents: { defaults: { workspace: "/missing-doctor-memory-workspace" } },
          memory: { search: { enabled: false, rememberAcrossConversations: false } },
          plugins: {
            ...plugins,
            entries: {
              "memory-core": {
                enabled: true,
                config: { dreaming: { enabled: true, frequency: "0 */4 * * *" } },
              },
              ...plugins?.entries,
            },
          },
        },
        options: { nonInteractive: true },
      });

      await runMemorySearchHealthContribution(ctx);

      expect(note).toHaveBeenCalledWith(
        "Memory search is explicitly disabled (enabled: false).",
        "Memory search",
      );
      expect(note).toHaveBeenCalledWith(
        [
          `Dreaming: ${enabled ? "enabled" : "disabled"} (cadence 0 */4 * * *).`,
          "Last recorded dreaming run: none recorded.",
          `Next scheduled run: ${enabled ? "none scheduled" : "dreaming disabled"}.`,
        ].join("\n"),
        "Memory search",
      );
      expect(getManager).not.toHaveBeenCalled();
      expect(getBackend).not.toHaveBeenCalled();
      expect(fs.existsSync(imported)).toBe(false);
      expect(note).toHaveBeenCalledTimes(2);
      expect(fs.existsSync(resolveOpenClawStateSqlitePath())).toBe(false);
    },
  );

  it("reads workspace phase history and the owned schedule without initializing memory", async () => {
    const workspace = path.join(root, "workspace");
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace } },
      memory: { search: { enabled: false, rememberAcrossConversations: false } },
      plugins: {
        entries: {
          "memory-core": { config: { dreaming: { enabled: true, frequency: "15 4 * * *" } } },
        },
      },
    };
    await appendMemoryHostEvent(workspace, {
      type: "memory.dream.completed",
      timestamp: "2026-10-07T04:15:00.000Z",
      phase: "deep",
      outcome: "failed",
      lineCount: 0,
      storageMode: "separate",
    });
    await appendMemoryHostEvent(path.join(root, "other-workspace"), {
      type: "memory.dream.completed",
      timestamp: "2026-10-08T04:15:00.000Z",
      phase: "rem",
      lineCount: 0,
      storageMode: "separate",
    });
    await appendMemoryHostEvent(workspace, {
      type: "memory.promotion.applied",
      timestamp: "2026-10-09T04:15:00.000Z",
      memoryPath: "MEMORY.md",
      applied: 0,
      candidates: [],
    });
    const job = {
      id: "managed",
      declarationKey: "memory-core:memory-dreaming-promotion",
      name: "Memory Dreaming Promotion",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "cron" as const, expr: "15 4 * * *" },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "Synthetic dreaming fixture" },
      state: { nextRunAtMs: Date.parse("2026-10-10T04:15:00.000Z") },
    };
    // An authored lookalike and a disabled duplicate must not move the next run.
    await saveCronStore(path.join(root, "state", "cron", "jobs.json"), {
      version: 1,
      jobs: [
        job,
        { ...job, id: "authored", declarationKey: undefined, state: { nextRunAtMs: 1 } },
        { ...job, id: "paused", enabled: false, state: { nextRunAtMs: 2 } },
      ],
    });

    for (const cronEnabled of [true, false]) {
      note.mockClear();
      await runMemorySearchHealthContribution(
        createDoctorHealthFlowContext({
          cfg: { ...cfg, cron: { enabled: cronEnabled } },
          options: { nonInteractive: true },
        }),
      );
      expect(note).toHaveBeenCalledWith(
        [
          "Dreaming: enabled (cadence 15 4 * * *).",
          "Last recorded dreaming run: 2026-10-07T04:15:00.000Z (deep, failed).",
          `Next scheduled run: ${cronEnabled ? "2026-10-10T04:15:00.000Z" : "cron disabled"}.`,
        ].join("\n"),
        "Memory search",
      );
    }
    expect(getManager).not.toHaveBeenCalled();
    expect(getBackend).not.toHaveBeenCalled();
    expect(fs.existsSync(imported)).toBe(false);
  });
});
