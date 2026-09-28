import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-code-mode-executor-"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(path.join(root, "index.js"), "export default {};\n");
    fs.writeFileSync(
      path.join(root, "code-mode-executor-api.js"),
      'export const codeModeExecutor = { id: "quickjs", async execute() { return { status: "completed", value: { kind: "complete", json: "42" }, output: { count: 0, source: { kind: "complete", json: "[]" } } }; } };\n',
    );
    loadManifestMetadataSnapshot.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "code-mode-quickjs",
            rootDir: root,
            source: path.join(root, "index.js"),
            origin: "bundled",
            contracts: { codeModeExecutors: ["quickjs"] },
          },
        ],
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("loads the selected bundled executor without global runtime registration", async () => {
    const executor = resolvePluginCodeModeExecutor("quickjs", {});
    expect(executor.id).toBe("quickjs");
    expect(
      await executor.execute(
        {
          kind: "exec",
          source: "return 42",
          catalog: [],
          namespaces: [],
          config: {
            timeoutMs: 1000,
            memoryLimitBytes: 1024 * 1024,
            maxOutputBytes: 1024,
            maxPendingToolCalls: 1,
            maxSnapshotBytes: 1024 * 1024,
          },
        },
        { timeoutMs: 1000 },
      ),
    ).toMatchObject({ status: "completed", value: { json: "42" } });
  });

  it.each([
    { plugins: { enabled: false } },
    { plugins: { allow: ["another-plugin"] } },
    { plugins: { enabled: false, allow: ["another-plugin"] } },
  ] satisfies OpenClawConfig[])("retains selected bundled runtime availability: %j", (config) => {
    expect(resolvePluginCodeModeExecutor("quickjs", config).id).toBe("quickjs");
  });

  it.each([
    { plugins: { deny: ["code-mode-quickjs"] } },
    { plugins: { entries: { "code-mode-quickjs": { enabled: false } } } },
    { plugins: { enabled: false, deny: ["code-mode-quickjs"] } },
    {
      plugins: { allow: ["another-plugin"], entries: { "code-mode-quickjs": { enabled: false } } },
    },
  ] satisfies OpenClawConfig[])(
    "fails when the bundled owner is explicitly blocked: %j",
    (config) => {
      expect(() => resolvePluginCodeModeExecutor("quickjs", config)).toThrow(
        'Code Mode executor "quickjs" is unavailable or disabled',
      );
    },
  );

  it.each([
    { plugins: { enabled: false } },
    { plugins: { deny: ["code-mode-quickjs"] } },
    { plugins: { allow: ["another-plugin"] } },
    { plugins: { entries: { "code-mode-quickjs": { enabled: false } } } },
  ] satisfies OpenClawConfig[])("retains the full policy for external executors: %j", (config) => {
    const snapshot = loadManifestMetadataSnapshot();
    snapshot.plugins[0].origin = "global";
    snapshot.index.plugins[0].origin = "global";
    expect(() => resolvePluginCodeModeExecutor("quickjs", config)).toThrow(
      'Code Mode executor "quickjs" is unavailable or disabled',
    );
  });

  it("loads an explicitly enabled external executor", () => {
    const snapshot = loadManifestMetadataSnapshot();
    snapshot.plugins[0].origin = "global";
    snapshot.index.plugins[0].origin = "global";
    const config = {
      plugins: {
        allow: ["code-mode-quickjs"],
        entries: { "code-mode-quickjs": { enabled: true } },
      },
    };
    expect(resolvePluginCodeModeExecutor("quickjs", config).id).toBe("quickjs");
  });

  it.each([
    { plugins: { enabled: false }, allowed: true },
    { plugins: { allow: ["openai"] }, allowed: true },
    { plugins: { enabled: false, deny: ["code-mode-quickjs"] }, allowed: false },
    {
      plugins: { allow: ["openai"], entries: { "code-mode-quickjs": { enabled: false } } },
      allowed: false,
    },
  ] satisfies Array<{ plugins: OpenClawConfig["plugins"]; allowed: boolean }>)(
    "preserves migrated QuickJS availability and owner policy: $plugins",
    ({ plugins, allowed }) => {
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
        expect(() => resolvePluginCodeModeExecutor(codeMode.executor, config)).toThrow(
          'Code Mode executor "quickjs" is unavailable or disabled',
        );
      }
      expect(raw).toEqual(original);
    },
  );

  it("fails when the selected plugin has no runtime artifact", () => {
    fs.unlinkSync(path.join(root, "code-mode-executor-api.js"));
    expect(() => resolvePluginCodeModeExecutor("quickjs", {})).toThrow(
      "missing its runtime artifact",
    );
  });

  it("rejects an artifact advertising another executor", () => {
    fs.writeFileSync(
      path.join(root, "code-mode-executor-api.js"),
      'export const codeModeExecutor = { id: "node", async execute() {} };\n',
    );
    expect(() => resolvePluginCodeModeExecutor("quickjs", {})).toThrow("invalid runtime artifact");
  });

  it("rejects ambiguous owners instead of choosing a different executor", () => {
    const snapshot = loadManifestMetadataSnapshot();
    snapshot.plugins.push({ ...snapshot.plugins[0], id: "second-executor" });
    expect(() => resolvePluginCodeModeExecutor("quickjs", {})).toThrow("multiple plugin owners");
  });
});
