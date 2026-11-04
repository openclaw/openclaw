import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { listDirectoryTreeStrict } from "../infra/directory-walk.js";

// The Gateway owns live agent databases; whole-database inspection copies stall it.
it("keeps Gateway code out of whole agent-database copy reads", async () => {
  const root = path.resolve(import.meta.dirname, "../gateway");
  const offenders: string[] = [];
  for (const { relativePath, dirent } of await listDirectoryTreeStrict(root)) {
    if (!dirent.isFile() || !relativePath.endsWith(".ts")) {
      continue;
    }
    if (/\.test(-support|-helpers)?\.ts$/.test(relativePath)) {
      continue;
    }
    if (
      (await fs.readFile(path.join(root, relativePath), "utf8")).includes("agentDatabases: true")
    ) {
      offenders.push(relativePath);
    }
  }
  expect(
    offenders,
    "use the live owner instead of withArtifactPreservingStateReads({ agentDatabases: true })",
  ).toEqual([]);
});
