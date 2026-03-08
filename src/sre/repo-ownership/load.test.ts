import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRepoOwnershipMap, resolveRepoOwnershipMapPath } from "./load.js";

const tempRoots: string[] = [];

async function createCaseRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sre-repo-ownership-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("loadRepoOwnershipMap", () => {
  it("derives the default ownership path from the SRE index dir", () => {
    expect(resolveRepoOwnershipMapPath({ stateDir: "/srv/openclaw" })).toBe(
      path.join("/srv/openclaw", "state", "sre-index", "repo-ownership.json"),
    );
  });

  it("loads and resolves both seed repos", async () => {
    const root = await createCaseRoot();
    const configPath = path.join(root, "repo-ownership.json");
    await fs.mkdir(path.join(root, "openclaw-sre"), { recursive: true });
    await fs.mkdir(path.join(root, "morpho-infra-helm"), { recursive: true });

    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          version: "sre.repo-ownership-map.v1",
          generatedAt: "2026-03-06T12:00:00.000Z",
          repos: [
            {
              repoId: "openclaw-sre",
              localPath: "./openclaw-sre",
              ownedGlobs: ["src/**", "package.json"],
              sourceOfTruthDomains: ["runtime"],
              dependentRepos: ["morpho-infra-helm"],
              ciChecks: ["pnpm build"],
              validationCommands: ["pnpm test -- src/sre"],
              rollbackHints: ["revert runtime patch"],
            },
            {
              repoId: "morpho-infra-helm",
              localPath: "./morpho-infra-helm",
              ownedGlobs: ["charts/openclaw-sre/**"],
              sourceOfTruthDomains: ["chart"],
              dependentRepos: ["openclaw-sre"],
              ciChecks: ["helm template"],
              validationCommands: ["helm lint charts/openclaw-sre"],
              rollbackHints: ["revert chart patch"],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = await loadRepoOwnershipMap(configPath);

    expect(loaded.repos.map((repo) => repo.repoId)).toEqual(["openclaw-sre", "morpho-infra-helm"]);
    expect(loaded.repos[0]?.resolvedLocalPath).toBe(path.join(root, "openclaw-sre"));
  });
});
