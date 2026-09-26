import { mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listBundledPluginPackArtifacts } from "../scripts/lib/bundled-plugin-build-entries.mjs";
import {
  collectInstalledPackageErrors,
  collectInstalledRootDependencyManifestErrors,
} from "../scripts/openclaw-npm-postpublish-verify.ts";
import { ALWAYS_ALLOWED_RUNTIME_DIR_NAMES } from "../src/plugin-sdk/facade-activation-contract.ts";
import { WORKER_BUNDLE_ARTIFACT_PATHS } from "../src/shared/worker-bundle-hash.js";
import { createTempDirTracker } from "./helpers/temp-dir.js";

const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.cleanup());

function fixture() {
  const root = tempDirs.make("npm-worker-contract-");
  const packageRoot = join(root, "package");
  const write = (relativePath: string, text = "export {};\n") => {
    const file = join(packageRoot, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const inventory = listBundledPluginPackArtifacts();
  for (const path of inventory) {
    write(path, path.endsWith(".json") ? "{}\n" : "export {};\n");
  }
  write("dist/postinstall-inventory.json", JSON.stringify(inventory));
  write("package.json", JSON.stringify({ name: "openclaw", version: "2026.9.1" }));
  write("dist/facade-activation-check.runtime.js");
  for (const name of ALWAYS_ALLOWED_RUNTIME_DIR_NAMES) {
    write(`dist/extensions/${name}/runtime-api.js`);
  }
  // Build output is populated from the producer, independently of the tooling reader.
  for (const path of WORKER_BUNDLE_ARTIFACT_PATHS) {
    write(`dist/worker/${path}`);
  }
  const workerDeployPaths = WORKER_BUNDLE_ARTIFACT_PATHS.map((path) => `dist/worker/${path}`);
  const verify = () =>
    collectInstalledPackageErrors({
      expectedVersion: "2026.9.1",
      installedVersion: "2026.9.1",
      packageRoot,
      workerDeployPaths,
    });
  return { packageRoot, write, workerDeployPaths, verify };
}

describe("installed target worker contract", () => {
  it("accepts the complete current producer and requires both literal helper artifacts", () => {
    const { packageRoot, write, verify } = fixture();
    expect(verify()).toEqual([]);
    for (const path of ["service-child-group-anchor.mjs", "service-child-relay.mjs"]) {
      const relativePath = `dist/worker/${path}`;
      rmSync(join(packageRoot, relativePath));
      expect(verify()).toEqual([
        `installed package worker deploy artifact is missing: ${relativePath}.`,
      ]);
      write(relativePath);
    }
  });

  it("rejects non-regular installed artifacts, including dangling symlinks", () => {
    const { packageRoot, verify } = fixture();
    const relativePath = "dist/worker/service-child-relay.mjs";
    const file = join(packageRoot, relativePath);
    rmSync(file);
    mkdirSync(file);
    expect(verify()).toEqual([
      `installed package worker deploy artifact is not a regular file: ${relativePath}.`,
    ]);
    rmSync(file, { recursive: true });
    symlinkSync(join(packageRoot, "missing.mjs"), file);
    expect(verify()).toEqual([
      `installed package worker deploy artifact is not a regular file: ${relativePath}.`,
    ]);
  });

  it("uses target membership for bounded scan exemptions without parsing worker ASTs", () => {
    const { packageRoot, write, workerDeployPaths } = fixture();
    const relativePath = "worker/service-child-relay.mjs";
    const workers = new Set(workerDeployPaths.map((path) => path.slice("dist/".length)));
    write(`dist/${relativePath}`, "not JavaScript");
    const file = join(packageRoot, "dist", relativePath);
    truncateSync(file, 6 * 1024 * 1024 + 1);
    expect(collectInstalledRootDependencyManifestErrors(packageRoot, [], false, workers)).toEqual(
      [],
    );
    expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toEqual([
      `installed package root dist file '${relativePath}' is invalid or exceeds 6291456 bytes.`,
    ]);
    truncateSync(file, 80 * 1024 * 1024 + 1);
    expect(collectInstalledRootDependencyManifestErrors(packageRoot, [], false, workers)).toEqual([
      `installed package root dist file '${relativePath}' is invalid or exceeds 83886080 bytes.`,
    ]);
  });
});
