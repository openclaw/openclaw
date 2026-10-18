import fs from "node:fs";
import path from "node:path";
import * as fsSafe from "@openclaw/fs-safe/advanced";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";

vi.mock("@openclaw/fs-safe/advanced", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/advanced")>()),
}));

const temp = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["success", "capture failure", "receipt failure"] as const)(
  "closes guarded open batches before capture retirement: %s",
  (phase) => {
    const root = fs.realpathSync(temp.make("plugin-open-batch-"));
    const source = path.join(root, "source");
    const captures = path.join(root, "captures");
    fs.mkdirSync(source);
    fs.mkdirSync(captures);
    fs.writeFileSync(path.join(source, "fixture.txt"), "captured bytes");
    const createBatch = fsSafe.createRootFileOpenBatchSync;
    const batches: Array<{ closed: boolean; roots: Set<string> }> = [];
    const failure = new Error("injected guarded open failure");
    vi.spyOn(fsSafe, "createRootFileOpenBatchSync").mockImplementation(() => {
      const batch = createBatch();
      const state = { closed: false, roots: new Set<string>() };
      batches.push(state);
      const close = () => {
        try {
          batch.close();
        } finally {
          state.closed = true;
          state.roots.clear();
        }
      };
      return {
        openFile(params) {
          state.roots.add(params.rootPath);
          const inCapture = params.absolutePath.startsWith(`${captures}${path.sep}`);
          if (
            (phase === "capture failure" && !inCapture) ||
            (phase === "receipt failure" && inCapture)
          ) {
            return { ok: false, reason: "io", error: failure };
          }
          return batch.openFile(params);
        },
        close,
        [Symbol.dispose]: close,
      };
    });
    const rm = fs.rmSync;
    let retired = false;
    vi.spyOn(fs, "rmSync").mockImplementation((filename, options) => {
      if (String(filename).startsWith(`${captures}${path.sep}`)) {
        // Model Windows directory handles that must be released before tree removal.
        expect(batches.every((batch) => batch.closed && batch.roots.size === 0)).toBe(true);
        retired = true;
      }
      rm(filename, options);
    });
    const capture = () =>
      withPluginSourceCaptureDirectory(captures, () =>
        capturePluginGenerationArtifact(source, undefined, (run) => run()),
      );
    if (phase === "success") {
      const artifact = capture();
      try {
        expect(fs.readFileSync(artifact.resolve(path.join(source, "fixture.txt")), "utf8")).toBe(
          "captured bytes",
        );
        expect(batches.every((batch) => batch.closed)).toBe(true);
      } finally {
        artifact.dispose();
      }
    } else {
      expect(capture).toThrow("Cannot capture plugin source");
    }
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.every((batch) => batch.closed)).toBe(true);
    expect(retired).toBe(true);
    expect(fs.readdirSync(captures)).toEqual([]);
  },
);
