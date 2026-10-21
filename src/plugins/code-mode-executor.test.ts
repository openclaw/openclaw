import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
const pluginId = "code-mode-quickjs";
const unavailable = 'Code Mode executor "quickjs" is unavailable or disabled';
const writeArtifact = (name: string, source: string) =>
  fs.writeFileSync(path.join(root, name), source);

function setOrigin(origin: "bundled" | "global") {
  const contracts = { codeModeExecutors: ["quickjs"] };
  const plugin = { id: pluginId, rootDir: root, origin, contracts };
  loadManifestMetadataSnapshot.mockReturnValue(
    createPluginMetadataSnapshotFixture({ plugins: [plugin] }),
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
  ["bundled", undefined, false, true],
  ["global", { allow: [pluginId], entries: { [pluginId]: { enabled: true } } }, false, true],
  ["global", { enabled: false }, false, false],
  ["global", { deny: [pluginId] }, false, false],
  ["global", { allow: ["another-plugin"] }, false, false],
  ["global", { entries: { [pluginId]: { enabled: false } } }, false, false],
  ["bundled", { enabled: false }, true, true],
  ["bundled", { allow: ["openai"] }, true, true],
  ["bundled", { enabled: false, deny: [pluginId] }, true, false],
  ["bundled", { allow: ["openai"], entries: { [pluginId]: { enabled: false } } }, true, false],
] satisfies Array<["global" | "bundled", OpenClawConfig["plugins"], boolean, boolean]>)(
  "enforces %s executor policy %j (migrate=%s, allowed=%s) and runs admitted artifacts",
  async (origin, plugins, migrate, allowed) => {
    setOrigin(origin);
    const raw = { tools: { codeMode: { enabled: true, runtime: "quickjs-wasi" } }, plugins };
    const original = structuredClone(raw);
    let config: OpenClawConfig = { plugins };
    if (migrate) {
      const migrated = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
      expect(migrated.partiallyValid).toBeUndefined();
      config = expectDefined(migrated.sourceConfig, "migrated QuickJS config");
      expect(config.plugins).toEqual(plugins);
      expect(resolveCodeModeConfig(config)).toMatchObject({ enabled: true, executor: "quickjs" });
    }
    if (allowed) {
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
    } else {
      expect(() => resolvePluginCodeModeExecutor("quickjs", config)).toThrow(unavailable);
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
