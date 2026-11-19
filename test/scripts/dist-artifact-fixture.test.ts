import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { installDistArtifactScripts } from "./dist-artifact-fixture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("installs every module its scripts and the dist-artifact owner statically import", () => {
  const root = tempDirs.make("openclaw-dist-artifact-fixture-");
  installDistArtifactScripts(root, [], { compiler: false, dependencies: [] });
  const installed = fs
    .readdirSync(path.join(root, "scripts"), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `scripts/${entry.name}`);
  const imported = collectRuntimeImportClosure(process.cwd(), [
    ...installed,
    "scripts/lib/dist-artifact-ownership.mts",
  ]);
  expect(imported.filter((file) => !fs.existsSync(path.join(root, file)))).toEqual([]);
});
