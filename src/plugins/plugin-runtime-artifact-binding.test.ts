import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareInstalledPluginCandidateResolver } from "./manifest-registry-installed.js";
import { createIndex } from "./manifest-registry-installed.test-helpers.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  bindPluginRuntimeArtifactSelection,
  hasCanonicalPluginDistribution,
} from "./plugin-runtime-artifact-binding.js";
import { createPluginRecord } from "./status.test-helpers.js";

const owner = vi.hoisted(() => ({ packageRoot: "" }));
vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRootSync: () => owner.packageRoot,
}));
let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-distribution-")));
  owner.packageRoot = root;
});
afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  fs.rmSync(root, { recursive: true, force: true });
});

function artifact(relative = "dist/extensions/workboard") {
  const rootDir = path.join(root, relative);
  fs.mkdirSync(rootDir, { recursive: true });
  const source = path.join(rootDir, "index.js");
  fs.writeFileSync(source, "export default {};");
  return { rootDir, source };
}

it("requires a completed canonical bundled runtime binding, not matching record metadata", () => {
  const runtimeEntry = artifact();
  const record = createPluginRecord({ id: "workboard", origin: "bundled", ...runtimeEntry });
  expect(hasCanonicalPluginDistribution(record)).toBe(false);
  const binding = bindPluginRuntimeArtifactSelection(record, { ...runtimeEntry, runtimeEntry });
  expect(hasCanonicalPluginDistribution(record)).toBe(false);
  binding.runtimeRegistrationComplete = true;
  expect(hasCanonicalPluginDistribution(record)).toBe(true);
  record.status = "error";
  expect(hasCanonicalPluginDistribution(record)).toBe(false);
});

it.each([
  "workspace",
  "global",
  "config",
  "preferred",
  "external",
  "source",
  "foreign",
  "unknown",
  "selected",
])("does not authorize a %s owner even with identical code and package fields", (kind) => {
  const canonical = artifact();
  const original =
    kind === "source"
      ? artifact("extensions/workboard")
      : kind === "foreign"
        ? artifact("foreign/dist/extensions/workboard")
        : canonical;
  const record = createPluginRecord({
    id: "workboard",
    packageName: "@openclaw/workboard",
    packageVersion: "1.0.0",
    origin: ["workspace", "global", "config"].includes(kind)
      ? (kind as "workspace" | "global" | "config")
      : "bundled",
    ...original,
  });
  const binding = bindPluginRuntimeArtifactSelection(record, {
    ...(kind === "unknown" ? {} : original),
    sourcePreferred: kind === "preferred",
    packageManifest: kind === "external" ? { build: { bundledDist: false } } : undefined,
    runtimeEntry: kind === "selected" ? artifact("dist/extensions/another") : canonical,
  });
  binding.runtimeRegistrationComplete = true;
  expect(hasCanonicalPluginDistribution(record)).toBe(false);
});

it("recognizes staging execution only when it resolves into the same canonical owner", () => {
  const canonical = artifact();
  const staging = artifact("dist-runtime/extensions/workboard");
  const record = createPluginRecord({ id: "workboard", origin: "bundled", ...staging });
  bindPluginRuntimeArtifactSelection(record, {
    ...staging,
    runtimeEntry: canonical,
  }).runtimeRegistrationComplete = true;
  expect(hasCanonicalPluginDistribution(record)).toBe(true);
});

it.each(["inside", "outside"])(
  "denies a compiled-tree redirect %s the running package",
  (where) => {
    const foreign = artifact(`${where === "inside" ? "owner/" : ""}foreign/extensions/workboard`);
    owner.packageRoot = path.join(root, "owner");
    fs.mkdirSync(path.join(owner.packageRoot, "dist"), { recursive: true });
    fs.symlinkSync(path.dirname(foreign.rootDir), path.join(owner.packageRoot, "dist/extensions"));
    const record = createPluginRecord({ id: "workboard", origin: "bundled", ...foreign });
    bindPluginRuntimeArtifactSelection(record, {
      ...foreign,
      runtimeEntry: foreign,
    }).runtimeRegistrationComplete = true;
    expect(hasCanonicalPluginDistribution(record)).toBe(false);
  },
);

it.each(["file", "directory", "symlink"])(
  "retains the configured %s exclusion after installed-index hydration",
  (kind) => {
    const runtimeEntry = artifact();
    fs.writeFileSync(
      path.join(runtimeEntry.rootDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/workboard",
        version: "1.0.0",
        openclaw: { extensions: ["./index.js"] },
      }),
    );
    fs.writeFileSync(
      path.join(runtimeEntry.rootDir, "openclaw.plugin.json"),
      JSON.stringify({ id: "workboard", configSchema: { type: "object" } }),
    );
    const alias = path.join(root, "linked-workboard");
    if (kind === "symlink") {
      fs.symlinkSync(runtimeEntry.rootDir, alias);
    }
    const index = createIndex(runtimeEntry.rootDir);
    const indexed = {
      ...index.plugins[0]!,
      pluginId: "workboard",
      origin: "bundled" as const,
      source: runtimeEntry.source,
    };
    const candidate = prepareInstalledPluginCandidateResolver({
      config: {
        plugins: {
          load: {
            paths: [
              kind === "file"
                ? runtimeEntry.source
                : kind === "symlink"
                  ? alias
                  : runtimeEntry.rootDir,
            ],
          },
        },
      },
      env: {
        ...process.env,
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "dist/extensions"),
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      },
    })(indexed);
    expect(candidate.sourcePreferred).toBe(true);
    const record = createPluginRecord({ id: "workboard", ...candidate });
    bindPluginRuntimeArtifactSelection(record, {
      ...candidate,
      runtimeEntry,
    }).runtimeRegistrationComplete = true;
    expect(hasCanonicalPluginDistribution(record)).toBe(false);
  },
);
