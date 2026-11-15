import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateConfigObjectWithPlugins } from "../config/validation.js";
import { loadPluginManifestRegistryCore } from "../plugins/manifest-registry.js";
import { runCommandBuffered } from "../process/exec.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";
import { materializeUpdateCandidateStateWorker } from "./update-candidate-state.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { linked: false, skipped: false },
  { linked: true, skipped: false },
  // The host skips this package but preserves its config; the candidate must match.
  { linked: false, skipped: true },
])(
  "rehearses an unrecorded global memory plugin (linked=$linked, skipped=$skipped)",
  async ({ linked, skipped }) => {
    const root = dirs.make("candidate-global-plugin-");
    const stateDir = path.join(root, "source-state");
    const locator = path.join(stateDir, "extensions", "memory-example");
    const plugin = linked ? path.join(root, "external", "memory-example") : locator;
    const candidateRoot = path.join(root, "candidate");
    await fs.mkdir(plugin, { recursive: true });
    await fs.mkdir(candidateRoot);
    if (linked) {
      await fs.mkdir(path.dirname(locator), { recursive: true });
      await fs.symlink(plugin, locator, "junction");
    }
    await fs.writeFile(path.join(candidateRoot, "package.json"), '{"name":"openclaw"}');
    await materializeUpdateCandidateStateWorker(candidateRoot);
    await fs.writeFile(
      path.join(plugin, "package.json"),
      JSON.stringify({
        name: "memory-example",
        type: "module",
        openclaw: {
          extensions: ["./index.js"],
          ...(skipped ? { compat: { pluginApi: "not a range" } } : {}),
        },
      }),
    );
    await fs.writeFile(
      path.join(plugin, "openclaw.plugin.json"),
      JSON.stringify({
        id: "memory-example",
        kind: "memory",
        configSchema: { type: "object" },
      }),
    );
    const entry = 'export default "private memory payload";';
    await fs.writeFile(path.join(plugin, "index.js"), entry);
    const config: OpenClawConfig = { plugins: { slots: { memory: "memory-example" } } };
    const env = {
      ...process.env,
      HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const validate = (value: OpenClawConfig, selectedEnv: NodeJS.ProcessEnv) => {
      const manifestRegistry = loadPluginManifestRegistryCore({
        config: value,
        env: selectedEnv,
        installRecords: {},
      });
      return validateConfigObjectWithPlugins(value, {
        env: selectedEnv,
        pluginMetadataSnapshot: { manifestRegistry },
      });
    };
    expect(validate(config, env).ok).toBe(true);
    const rehearsal = await prepareUpdateCandidateRehearsal({
      config,
      stateDir,
      candidateRoot,
      env,
    });
    try {
      const copied: OpenClawConfig = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
      const validation = validate(copied, rehearsal.env);
      expect(validation, JSON.stringify(validation)).toMatchObject({ ok: true });
      expect(copied.plugins?.load).toBeUndefined();
      expect(copied.plugins?.installs).toBeUndefined();
      expect(await fs.readFile(path.join(plugin, "index.js"), "utf8")).toBe(entry);
      await fs.rename(plugin, path.join(root, "original-unavailable"));
      const copiedEntry = path.join(rehearsal.stateDir, "extensions", "memory-example", "index.js");
      const result = await runCommandBuffered(
        [
          process.execPath,
          "--input-type=module",
          "-e",
          `console.log((await import(${JSON.stringify(pathToFileURL(copiedEntry).href)})).default)`,
        ],
        { timeoutMs: 10_000 },
      );
      expect(result.code, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString().trim()).toBe("private memory payload");
    } finally {
      await rehearsal.cleanup();
    }
  },
);
