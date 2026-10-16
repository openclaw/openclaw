import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import * as tar from "tar";
import { vi } from "vitest";
import {
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  readWorkerBundleDirectoryManifest,
} from "../shared/worker-bundle-archive.js";
import { hashWorkerBundleManifest } from "../shared/worker-bundle-hash.js";
import type { NodeWorkerBundleInstallInput } from "../worker/node-bundle-install-protocol.js";

export type BundleFixtureOptions = {
  packageShell?: boolean;
  prewarmMarker?: string;
  workerSource?: string;
  fixtureName?: string;
  bundlePrewarm?: 1;
  compileCacheDisabled?: boolean;
};

export type BundleFixture = {
  archive: Buffer;
  input: NodeWorkerBundleInstallInput;
};

export async function buildBundleFixture(
  fixtureRoot: string,
  options: BundleFixtureOptions = {},
): Promise<BundleFixture> {
  const fixtureName = options.fixtureName ?? "default";
  const source = path.join(fixtureRoot, `source-${fixtureName}`);
  const archivePath = path.join(fixtureRoot, `bundle-${fixtureName}.tgz`);
  await fs.mkdir(source, { recursive: true });
  const compileCacheDisabled =
    options.compileCacheDisabled ?? process.env.NODE_DISABLE_COMPILE_CACHE !== undefined;
  const workerSource =
    options.workerSource ??
    (options.prewarmMarker
      ? `import fs from "node:fs";\nconst cacheDisabled = process.env.NODE_DISABLE_COMPILE_CACHE === "1";\nif (process.argv[2] !== "--internal-worker-prewarm" || cacheDisabled !== ${compileCacheDisabled} || (cacheDisabled ? process.env.NODE_COMPILE_CACHE : !process.env.NODE_COMPILE_CACHE)) throw new Error("worker bundle was not prewarmed with the requested compile-cache mode");\nfs.writeFileSync(${JSON.stringify(options.prewarmMarker)}, "ready");\n`
      : "export {};\n");
  await fs.writeFile(path.join(source, "worker.mjs"), workerSource, { mode: 0o700 });
  for (const artifact of ["github-exec-launcher.mjs", "workspace-rsync-receiver.mjs"]) {
    await fs.writeFile(path.join(source, artifact), "export {};\n", { mode: 0o700 });
  }
  const archiveEntries = ["github-exec-launcher.mjs", "worker.mjs", "workspace-rsync-receiver.mjs"];
  if (options.packageShell) {
    await fs.mkdir(path.join(source, "dist"));
    await fs.writeFile(path.join(source, "openclaw.mjs"), "#!/usr/bin/env node\n", {
      mode: 0o700,
    });
    await fs.writeFile(path.join(source, "package.json"), '{"name":"openclaw"}\n');
    await fs.writeFile(path.join(source, "dist", "worker.js"), "export {};\n");
    archiveEntries.push("dist/worker.js", "openclaw.mjs", "package.json");
  }
  const manifest = await readWorkerBundleDirectoryManifest({
    root: source,
    limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  });
  const bundleHash = hashWorkerBundleManifest(manifest);
  await tar.create(
    { cwd: source, file: archivePath, gzip: true, noDirRecurse: true },
    archiveEntries,
  );
  const archive = await fs.readFile(archivePath);
  return {
    archive,
    input: {
      gatewayNamespace: "gateway-test",
      ...(options.bundlePrewarm ? { bundlePrewarm: options.bundlePrewarm } : {}),
      build: { bundleHash, openclawVersion: "2026.8.1", protocolFeatures: [] },
      archive: {
        token: "A".repeat(43),
        sha256: createHash("sha256").update(archive).digest("hex"),
        bytes: archive.byteLength,
      },
    },
  };
}

export function interruptAfterStagingWrite() {
  let response: http.ServerResponse | undefined;
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await open(...args);
    if (path.basename(String(args[0])) === "bundle.tgz") {
      const write = file.writeFile.bind(file);
      vi.spyOn(file, "writeFile").mockImplementation(async (...writeArgs) => {
        await write(...writeArgs);
        // Wait for persisted bytes, not a timer or a server-side socket flush.
        response?.destroy();
        response = undefined;
      });
    }
    return file;
  });
  return (res: http.ServerResponse, chunk: Buffer) => {
    response = res;
    res.write(chunk);
  };
}
