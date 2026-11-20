import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

it("loads the dist-artifact owner from a source checkout that stages only scripts/", async () => {
  // Update imports the installed checkout's owner (update-command-runtime.ts); its update
  // lease fixture stages scripts/ alone, so the owner may not reach past it.
  const root = tempDirs.make("openclaw-dist-artifact-scripts-only-");
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ extends: path.resolve("tsconfig.json") }),
  );
  fs.symlinkSync(
    path.resolve("scripts"),
    path.join(root, "scripts"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const owner: unknown = await import(
    pathToFileURL(path.join(root, "scripts/lib/dist-artifact-ownership.mts")).href
  );
  expect(owner).toMatchObject({
    runDistArtifactChild: expect.any(Function),
    withDistArtifactOwnership: expect.any(Function),
  });
});
