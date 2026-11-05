import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { saveCronStore } from "../cron/store.js";
import { appendMemoryHostEvent } from "../memory-host-sdk/events.js";
import { clearPluginRegistryLoadCache } from "../plugins/loader.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { runMemorySearchHealthContribution } from "./doctor-health-contribution-runners.workspace.js";
import { createDoctorHealthFlowContext } from "./doctor-health-contributions.test-support.js";

const { note, unexpectedRuntime } = vi.hoisted(() => ({
  note: vi.fn(),
  unexpectedRuntime: vi.fn(() => {
    throw new Error("ordinary Doctor must not load the memory runtime");
  }),
}));

const expectNote = (message: string) => expect(note).toHaveBeenCalledWith(message, "Memory search");

function plugin(dreaming = true, enabled?: boolean, frequency = "0 */4 * * *") {
  return {
    ...(enabled === undefined ? {} : { enabled }),
    config: { dreaming: { enabled: dreaming, frequency } },
  };
}

function memoryConfig(workspace: string, plugins: OpenClawConfig["plugins"]): OpenClawConfig {
  return {
    agents: { defaults: { workspace } },
    memory: { search: { enabled: false, rememberAcrossConversations: false } },
    plugins: { ...plugins, entries: { "memory-core": plugin(true, true), ...plugins?.entries } },
  };
}

function run(cfg: OpenClawConfig) {
  return runMemorySearchHealthContribution(
    createDoctorHealthFlowContext({ cfg, options: { nonInteractive: true } }),
  );
}

vi.mock("../../packages/terminal-core/src/note.js", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("../../packages/terminal-core/src/note.js")>()),
    note,
  };
});
vi.mock("../plugins/memory-runtime.js", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("../plugins/memory-runtime.js")>()),
    getActiveMemorySearchManagerCore: unexpectedRuntime,
    resolveActiveMemoryBackendConfig: unexpectedRuntime,
  };
});

let root: string;
let imported: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-memory-output-"));
  imported = path.join(root, "plugin-imported");
  for (const id of ["memory-core", "memory-provider"]) {
    const dir = path.join(root, "bundled", id);
    fs.mkdirSync(dir, { recursive: true });
    const write = (name: string, content: string) =>
      fs.writeFileSync(path.join(dir, name), content);
    write(
      "openclaw.plugin.json",
      JSON.stringify({ id, kind: "memory", configSchema: { type: "object" } }),
    );
    write("index.js", `require("node:fs").writeFileSync(${JSON.stringify(imported)}, "imported");`);
    if (id === "memory-core") {
      write(
        "dreaming-status-api.js",
        `module.exports = require(${JSON.stringify(path.resolve("extensions/memory-core/dreaming-status-api.ts"))});`,
      );
    }
  }
});

beforeEach(() => {
  for (const mock of [note, unexpectedRuntime]) {
    mock.mockClear();
  }
  clearPluginRegistryLoadCache();
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(root, "bundled"));
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
  vi.stubEnv("OPENCLAW_SKIP_CRON", undefined);
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
  expect(unexpectedRuntime).not.toHaveBeenCalled();
  expect(fs.existsSync(imported)).toBe(false);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it.each<[string, OpenClawConfig["plugins"], boolean]>([
  ["default plugin", {}, true],
  ["dreaming off", { entries: { "memory-core": plugin(false) } }, false],
  ["plugins off", { enabled: false }, false],
  ["memory plugin off", { entries: { "memory-core": plugin(true, false) } }, false],
  ["memory denied", { deny: ["memory-core"] }, false],
  ["memory slot off", { slots: { memory: "none" } }, false],
  [
    "provider sidecar with allowlist",
    {
      allow: ["memory-provider"],
      slots: { memory: "memory-provider" },
      entries: {
        "memory-core": plugin(false, true, "0 */12 * * *"),
        "memory-provider": plugin(true, true),
      },
    },
    true,
  ],
  [
    "selected provider off",
    {
      slots: { memory: "memory-provider" },
      entries: { "memory-provider": plugin(true, false) },
    },
    false,
  ],
])(
  "reports effective dreaming for %s without loading plugins",
  async (_label, plugins, enabled) => {
    await run(memoryConfig("/missing-doctor-memory-workspace", plugins));

    expectNote("Memory search is explicitly disabled (enabled: false).");
    expectNote(
      `Dreaming: ${enabled ? "enabled" : "disabled"} (cadence 0 */4 * * *).
Last recorded dreaming run: none recorded.
Next scheduled run: ${enabled ? "none scheduled" : "dreaming disabled"}.`,
    );
    expect(note).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(resolveOpenClawStateSqlitePath())).toBe(false);
  },
);

it("reads workspace phase history and the owned schedule without initializing memory", async () => {
  const workspace = path.join(root, "workspace");
  const cfg = memoryConfig(workspace, {
    entries: { "memory-core": plugin(true, undefined, "15 4 * * *") },
  });
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
  const job = makeCronJob({
    id: "managed",
    declarationKey: "memory-core:memory-dreaming-promotion",
    schedule: { kind: "cron", expr: "15 4 * * *" },
    state: { nextRunAtMs: Date.parse("2026-10-10T04:15:00.000Z") },
  });
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
    await run({ ...cfg, cron: { enabled: cronEnabled } });
    expectNote(
      `Dreaming: enabled (cadence 15 4 * * *).
Last recorded dreaming run: 2026-10-07T04:15:00.000Z (deep, failed).
Next scheduled run: ${cronEnabled ? "2026-10-10T04:15:00.000Z" : "cron disabled"}.`,
    );
  }
});
