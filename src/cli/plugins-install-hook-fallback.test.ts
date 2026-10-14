// A blocked plugin install keeps its rejection while surfacing why the hook-pack probe failed.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { loadConfigForInstall } from "../plugins/install-config.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { pinConfigDir } from "../utils.js";
import { installPluginWithHookFallback } from "./plugins-install-hook-fallback.js";

let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "hook-fallback-probe", layout: "split" });
  pinConfigDir();
  // An unsupported plugins include shape blocks plugin config writes while hooks stay writable.
  await state.writeConfig({
    agents: { defaults: { workspace: state.workspaceDir } },
    plugins: { $include: "./plugins.json", enabled: false },
  } as never);
  await fs.writeFile(path.join(path.dirname(state.configPath), "plugins.json"), "{}\n", "utf-8");
});

afterEach(async () => {
  await state.cleanup();
  pinConfigDir();
});

function captureRuntime() {
  const logs: string[] = [];
  const runtime = {
    log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    exit: (code: number) => {
      throw new Error(`unexpected exit ${code}`);
    },
  } as RuntimeEnv;
  return { logs, runtime };
}

it.each([
  {
    probe: "fails unexpectedly",
    packageJson: "{ not json",
    surfaced: true,
  },
  {
    probe: "confirms a plugin package without hooks",
    packageJson: JSON.stringify({ name: "@acme/plain-plugin", version: "0.0.0" }),
    surfaced: false,
  },
])(
  "keeps the plugin rejection when the hook-pack probe $probe",
  async ({ packageJson, surfaced }) => {
    const sourceDir = state.path("sources", "candidate");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "package.json"), packageJson, "utf-8");
    const snapshot = await loadConfigForInstall({ rawSpec: sourceDir });
    const pluginMutation = snapshot.pluginMutation;
    if (pluginMutation.mode !== "blocked") {
      throw new Error("expected the plugins include shape to block plugin config writes");
    }
    expect(snapshot.hookMutation.mode).not.toBe("blocked");
    const { logs, runtime } = captureRuntime();

    const result = await installPluginWithHookFallback({
      request: { source: "local", path: sourceDir, mode: "install" },
      snapshot,
      safetyOverrides: { config: snapshot.config },
      runtime,
    });

    expect(result).toMatchObject({ ok: false, error: pluginMutation.reason });
    const probeWarnings = logs.filter((line) => line.includes("Hook-pack fallback"));
    if (surfaced) {
      expect(probeWarnings).toHaveLength(1);
      expect(probeWarnings[0]).toContain("package.json");
    } else {
      expect(probeWarnings).toEqual([]);
    }
  },
);
