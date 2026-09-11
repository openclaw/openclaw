import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readUpdateStateSchemaVersions } from "./update-candidate-state.js";
import { readUpdateStateDatabaseSizes } from "./update-candidate-state.sizes.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Inject metadata faults only in the child; the parent must remain able to cancel it.
function writeMetadataFault(root: string, target: string, block: boolean): string {
  const preload = path.join(root, "metadata-fault.cjs");
  fs.writeFileSync(
    preload,
    `
    const fs = require("node:fs");
    const stat = fs.statSync;
    fs.statSync = function(file, ...args) {
      if (file === ${JSON.stringify(target)}) {
        if (${block}) {
          process.on("SIGTERM", () => {});
          fs.writeFileSync(${JSON.stringify(path.join(root, "started.json"))}, JSON.stringify({
            pid: process.pid, stagingRoot: process.env.XDG_CACHE_HOME,
          }));
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        throw Object.assign(new Error("metadata unavailable"), { code: "EIO" });
      }
      return stat.call(this, file, ...args);
    };
    `,
  );
  return preload;
}

it.each(["", "-wal", "-journal"])(
  "keeps an unknown size when %s metadata cannot be read",
  async (suffix) => {
    const root = tempDirs.make("openclaw-metadata-unknown-");
    const file = path.join(root, "database.sqlite");
    fs.writeFileSync(file, "database");
    const preload = writeMetadataFault(root, `${file}${suffix}`, false);
    await expect(
      readUpdateStateDatabaseSizes([file, path.join(root, "missing.sqlite")], {
        nodeRunner: process.execPath,
        sourceEnv: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
        stagingRoot: root,
      }),
    ).resolves.toEqual([{ path: file, sizeBytes: undefined }]);
  },
);

it.each(["", "-wal", "-journal"])(
  "cancels blocked %s metadata before candidate discovery and removes staging after child exit",
  async (suffix) => {
    const root = tempDirs.make("openclaw-metadata-cancel-");
    const file = path.join(root, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, "database");
    const preload = writeMetadataFault(root, `${file}${suffix}`, true);
    const controller = new AbortController();
    const inspection = readUpdateStateSchemaVersions({
      stateDir: root,
      config: {},
      // No candidate worker exists: cancellation must happen during metadata inventory.
      root: path.join(root, "unavailable-candidate"),
      signal: controller.signal,
      env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
    });
    const rejected = expect(inspection).rejects.toThrow();
    let report: { pid: number; stagingRoot: string } | undefined;
    try {
      await vi.waitFor(() => {
        report = JSON.parse(fs.readFileSync(path.join(root, "started.json"), "utf8"));
        expect(report).toBeDefined();
      });
      expect(fs.existsSync(report!.stagingRoot)).toBe(true);
    } finally {
      controller.abort(new Error("metadata cancellation"));
      await rejected;
    }
    expect(() => process.kill(report!.pid, 0)).toThrow();
    expect(fs.existsSync(report!.stagingRoot)).toBe(false);
  },
);
