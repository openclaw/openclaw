import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../commands/doctor-memory-recall.js";
import "../commands/doctor-memory-search.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginRegistryLoadCache } from "../plugins/loader.js";
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
  });

  afterEach(() => vi.unstubAllEnvs());
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
        `Dreaming: ${enabled ? "enabled" : "disabled"} (cadence 0 */4 * * *).`,
        "Memory search",
      );
      expect(getManager).not.toHaveBeenCalled();
      expect(getBackend).not.toHaveBeenCalled();
      expect(fs.existsSync(imported)).toBe(false);
      expect(note).toHaveBeenCalledTimes(2);
    },
  );
});
