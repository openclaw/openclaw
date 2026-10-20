import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveCodeModeConfig } from "../agents/code-mode-runtime.js";
import { migrateLegacyConfig } from "../commands/doctor/shared/legacy-config-migrate.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const loadManifestMetadataSnapshot = vi.hoisted(() => vi.fn());
vi.mock("./manifest-contract-eligibility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./manifest-contract-eligibility.js")>()),
  loadManifestMetadataSnapshot,
}));

import { resolvePluginCodeModeExecutor } from "./code-mode-executor.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

describe("Code Mode executor plugin selection", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let root: string;
  const pluginId = "code-mode-quickjs";
  const unavailable = 'Code Mode executor "quickjs" is unavailable or disabled';
  const writeArtifact = (name: string, source: string) =>
    fs.writeFileSync(path.join(root, name), source);

  function setOrigin(origin: "bundled" | "global") {
    loadManifestMetadataSnapshot.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: pluginId,
            rootDir: root,
            origin,
            contracts: { codeModeExecutors: ["quickjs"] },
          },
        ],
      }),
    );
  }

  beforeEach(() => {
    root = tempDirs.make("openclaw-code-mode-executor-");
    writeArtifact("package.json", JSON.stringify({ type: "module" }));
    writeArtifact("index.js", "export default {};\n");
    writeArtifact(
      "code-mode-executor-api.js",
      'export const codeModeExecutor = { id: "quickjs", async execute() { return { status: "completed", value: { kind: "complete", json: "42" }, output: { count: 0, source: { kind: "complete", json: "[]" } } }; } };\n',
    );
    setOrigin("bundled");
  });

  it.each([
    ["bundled", {}],
    ["global", { plugins: { allow: [pluginId], entries: { [pluginId]: { enabled: true } } } }],
  ] satisfies Array<["bundled" | "global", OpenClawConfig]>)(
    "loads the selected %s executor without global runtime registration",
    async (origin, config) => {
      setOrigin(origin);
      const executor = resolvePluginCodeModeExecutor("quickjs", config);
      expect(executor.id).toBe("quickjs");
      const result = await executor.execute(
        {
          kind: "exec",
          source: "return 42",
          catalog: [],
          namespaces: [],
          config: resolveCodeModeConfig(),
        },
        { timeoutMs: 1000 },
      );
      expect(result).toMatchObject({ status: "completed", value: { json: "42" } });
    },
  );

  it.each([
    { plugins: { enabled: false } },
    { plugins: { deny: [pluginId] } },
    { plugins: { allow: ["another-plugin"] } },
    { plugins: { entries: { [pluginId]: { enabled: false } } } },
  ] satisfies OpenClawConfig[])("retains the full policy for external executors: %j", (config) => {
    setOrigin("global");
    expect(() => resolvePluginCodeModeExecutor("quickjs", config)).toThrow(unavailable);
  });

  it.each([
    [{ enabled: false }, true],
    [{ allow: ["openai"] }, true],
    [{ enabled: false, deny: [pluginId] }, false],
    [{ allow: ["openai"], entries: { [pluginId]: { enabled: false } } }, false],
  ] satisfies Array<[OpenClawConfig["plugins"], boolean]>)(
    "preserves migrated QuickJS availability and owner policy: %j => %s",
    (plugins, allowed) => {
      const raw = {
        tools: { codeMode: { enabled: true, runtime: "quickjs-wasi" } },
        plugins,
      };
      const original = structuredClone(raw);
      const migrated = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
      expect(migrated.partiallyValid).toBeUndefined();
      const config = expectDefined(migrated.sourceConfig, "migrated QuickJS config");
      expect(config.plugins).toEqual(plugins);
      const codeMode = resolveCodeModeConfig(config);
      expect(codeMode).toMatchObject({ enabled: true, executor: "quickjs" });
      if (allowed) {
        expect(resolvePluginCodeModeExecutor(codeMode.executor, config).id).toBe("quickjs");
      } else {
        expect(() => resolvePluginCodeModeExecutor(codeMode.executor, config)).toThrow(unavailable);
      }
      expect(raw).toEqual(original);
    },
  );

  it.each([
    ["missing", "missing its runtime artifact"],
    ["mismatched", "invalid runtime artifact"],
    ["ambiguous", "multiple plugin owners"],
  ])("rejects a %s executor owner", (kind, error) => {
    const artifact = path.join(root, "code-mode-executor-api.js");
    if (kind === "missing") {
      fs.unlinkSync(artifact);
    } else if (kind === "mismatched") {
      writeArtifact(
        "code-mode-executor-api.js",
        'export const codeModeExecutor = { id: "node", async execute() {} };\n',
      );
    } else {
      const snapshot = loadManifestMetadataSnapshot();
      snapshot.plugins.push({ ...snapshot.plugins[0], id: "second-executor" });
    }
    expect(() => resolvePluginCodeModeExecutor("quickjs", {})).toThrow(error);
  });
});
