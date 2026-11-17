import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginPackageMetadataCapture } from "./plugin-package-metadata-capture.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "reuses retained package metadata without rereading (invalid: %s)",
  (invalid) => {
    const root = temp.make("plugin-retained-metadata-");
    const filename = path.join(root, "package.json");
    const manifest = { name: "fixture", exports: "./index.js" };
    fs.writeFileSync(filename, invalid ? "{" : JSON.stringify(manifest));
    const read = vi.spyOn(fs, "readFileSync");
    const create = (retainedManifest?: () => Record<string, unknown> | null) =>
      createPluginPackageMetadataCapture({
        retainedManifest,
        sourceForCaptured: () => filename,
        packageForFile: () => undefined,
      });
    const initial = create();
    initial.record(filename, () => undefined);
    initial.prepare();
    expect(read).toHaveBeenCalledTimes(1);
    const reconstructed = create(() => (invalid ? null : manifest));
    reconstructed.record(filename, () => undefined);
    reconstructed.prepare();
    if (!invalid) {
      expect(reconstructed.dependencyPlan(filename).manifest).toBe(manifest);
    }
    expect(read).toHaveBeenCalledTimes(1);
  },
);

it("reconstructs legacy package metadata from a relocated snapshot after owner disposal", () => {
  const root = temp.make("plugin-metadata-relocation-");
  fs.writeFileSync(path.join(root, "package.json"), '{"main":"index.js"}');
  fs.writeFileSync(path.join(root, "index.js"), "module.exports = 7;");
  const read = vi.spyOn(fs, "readFileSync");
  const capture = (
    destination: string,
    retained?: ReadonlyMap<string, Record<string, unknown> | null>,
  ) => {
    const metadata = createPluginPackageMetadataCapture({
      retainedManifest: (filename) => retained?.get(path.relative(destination, filename)),
      sourceForCaptured: () => undefined,
      packageForFile: () => undefined,
    });
    fs.mkdirSync(destination);
    metadata.capturePackage(root, destination, (source, target) => {
      fs.copyFileSync(source, target);
      if (target.endsWith("package.json")) {
        metadata.record(target, () => undefined);
      }
    });
    expect(fs.existsSync(path.join(destination, "index.js"))).toBe(true);
    return metadata;
  };
  const first = path.join(root, "first");
  const initial = capture(first);
  const retained = initial.snapshot(first);
  initial.clear();
  capture(path.join(root, "second"), retained).clear();
  expect(read).toHaveBeenCalledTimes(1);
});
