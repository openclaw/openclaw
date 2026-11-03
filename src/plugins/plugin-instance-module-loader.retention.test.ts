import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { InspectionNativeEsmRetention } from "./plugin-cache-artifacts.js";
import { hasRetainedNativeEsmArtifact } from "./plugin-instance-module-loader.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

function inspectionTarget() {
  const root = temp.make("plugin-retained-esm-inspection-");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  const source = path.join(root, "index.js");
  const inspectionRetention: InspectionNativeEsmRetention = {
    sources: new Map([[source, "installed-source"]]),
    workspaces: new Set([root]),
  };
  return { source, inspectionRetention, registry: undefined };
}

it("does not require a pruned bundled entry while checking inspection retention", () => {
  expect(hasRetainedNativeEsmArtifact({ ...inspectionTarget(), origin: "bundled" })).toBe(false);
});

it("keeps missing non-bundled inspection entries visible as filesystem failures", () => {
  expect(() => hasRetainedNativeEsmArtifact({ ...inspectionTarget(), origin: "global" })).toThrow(
    /ENOENT/,
  );
});

it("reports no retained artifact for a newly installed native ESM entry", () => {
  const target = inspectionTarget();
  fs.writeFileSync(target.source, 'export const value = "installed";');
  expect(hasRetainedNativeEsmArtifact({ ...target, origin: "global" })).toBe(false);
});
