import fs from "node:fs/promises";
import path from "node:path";

/** A built release (or checkout) with the provenance and artifacts update verification reads. */
export async function writeGitReleaseBuild(
  root: string,
  commit: string,
  buildId: string,
  version = "1.0.0",
): Promise<string> {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "openclaw", version }),
    "dist/entry.js": "",
    "dist/build-info.json": JSON.stringify({ commit, buildId, version }),
    "dist/.buildstamp": JSON.stringify({ head: commit }),
    "dist/.runtime-postbuildstamp": JSON.stringify({ head: commit }),
    "dist/control-ui/index.html": "ready",
  };
  for (const [file, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), contents);
  }
  return root;
}
