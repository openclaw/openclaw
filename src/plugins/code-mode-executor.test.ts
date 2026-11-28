import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WorkerDeployCodeModeExecutorOwner } from "./worker-deploy-code-mode-executors.js";

const { loadManifestMetadataSnapshot, workerDeployCodeModeExecutors } = vi.hoisted(() => ({
  loadManifestMetadataSnapshot: vi.fn(),
  workerDeployCodeModeExecutors: [] as WorkerDeployCodeModeExecutorOwner[],
}));
vi.mock("./manifest-contract-eligibility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./manifest-contract-eligibility.js")>()),
  loadManifestMetadataSnapshot,
}));
vi.mock("./worker-deploy-code-mode-executors.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-deploy-code-mode-executors.js")>()),
  workerDeployCodeModeExecutors,
}));

import {
  assertWorkerPluginCodeModeExecutorAllowed,
  resolvePluginCodeModeExecutor,
} from "./code-mode-executor.js";
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
  workerDeployCodeModeExecutors.length = 0;
  loadManifestMetadataSnapshot.mockClear();
  root = tempDirs.make("openclaw-code-mode-executor-");
  writeArtifact("package.json", JSON.stringify({ type: "module" }));
  writeArtifact("index.js", "export default {};\n");
  writeArtifact(
    "code-mode-executor-api.js",
    'export const codeModeExecutor = { id: "quickjs", async execute() {} };\n',
  );
  setOrigin("bundled");
});

it.each([
  ["bundled", undefined, true],
  ["global", { allow: [pluginId], entries: { [pluginId]: { enabled: true } } }, true],
  ["global", { enabled: false }, false],
  ["global", { deny: [pluginId] }, false],
  ["global", { allow: ["another-plugin"] }, false],
  ["global", { entries: { [pluginId]: { enabled: false } } }, false],
  ["bundled", { enabled: false }, true],
  ["bundled", { allow: ["openai"] }, true],
  ["bundled", { enabled: false, deny: [pluginId] }, false],
  ["bundled", { allow: ["openai"], entries: { [pluginId]: { enabled: false } } }, false],
] satisfies Array<["global" | "bundled", OpenClawConfig["plugins"], boolean]>)(
  "enforces %s executor policy %j (allowed=%s)",
  (origin, plugins, allowed) => {
    setOrigin(origin);
    const config = { plugins };
    const original = structuredClone(config);
    if (allowed) {
      expect(resolvePluginCodeModeExecutor("quickjs", config).id).toBe("quickjs");
    } else {
      expect(() => resolvePluginCodeModeExecutor("quickjs", config)).toThrow(unavailable);
    }
    expect(config).toEqual(original);
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

it("resolves composed worker-deploy executors without manifest discovery while enforcing plugin policy", () => {
  const composedExecutor = {
    id: "quickjs" as const,
    execute: vi.fn(),
  };
  workerDeployCodeModeExecutors.push({
    manifest: {
      id: pluginId,
      origin: "bundled",
      contracts: { codeModeExecutors: ["quickjs"] },
    },
    executor: composedExecutor,
  });
  // The ambient plugin advertises the same executor but has no usable artifact.
  fs.unlinkSync(path.join(root, "code-mode-executor-api.js"));
  for (const plugins of [undefined, { enabled: false }, { allow: ["openai"] }]) {
    expect(() => assertWorkerPluginCodeModeExecutorAllowed("quickjs", { plugins })).not.toThrow();
    expect(resolvePluginCodeModeExecutor("quickjs", { plugins })).toBe(composedExecutor);
  }
  for (const plugins of [{ deny: [pluginId] }, { entries: { [pluginId]: { enabled: false } } }]) {
    expect(() => assertWorkerPluginCodeModeExecutorAllowed("quickjs", { plugins })).toThrow(
      unavailable,
    );
    expect(() => resolvePluginCodeModeExecutor("quickjs", { plugins })).toThrow(unavailable);
  }

  expect(loadManifestMetadataSnapshot).not.toHaveBeenCalled();
});

it("refuses an admitted external replacement for a denied bundled owner on portable workers", () => {
  const externalId = "external-quickjs";
  const config = {
    plugins: {
      allow: [externalId],
      deny: [pluginId],
      entries: { [externalId]: { enabled: true } },
    },
  };
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      { id: pluginId, origin: "bundled", contracts: { codeModeExecutors: ["quickjs"] } },
      { id: externalId, origin: "global", contracts: { codeModeExecutors: ["quickjs"] } },
    ],
  });
  expect(() => assertWorkerPluginCodeModeExecutorAllowed("quickjs", config, snapshot)).toThrow(
    `plugin "${externalId}", which is unavailable in portable workers`,
  );
});
