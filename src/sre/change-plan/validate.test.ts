import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ChangePlan } from "../contracts/change-plan.js";
import { validateChangePlan } from "./validate.js";

const tempRoots: string[] = [];

async function createFixture(): Promise<{ cfg: OpenClawConfig; runtimeRepo: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-change-plan-"));
  tempRoots.push(root);
  const runtimeRepo = path.join(root, "openclaw-sre");
  await fs.mkdir(path.join(runtimeRepo, "src"), { recursive: true });
  const ownershipPath = path.join(root, "repo-ownership.json");
  await fs.writeFile(
    ownershipPath,
    JSON.stringify(
      {
        version: "sre.repo-ownership-map.v1",
        generatedAt: "2026-03-08T00:00:00.000Z",
        repos: [
          {
            repoId: "openclaw-sre",
            localPath: runtimeRepo,
            ownedGlobs: ["src/**"],
            sourceOfTruthDomains: ["runtime"],
            dependentRepos: [],
            ciChecks: ["pnpm build"],
            validationCommands: ["pnpm build"],
            rollbackHints: ["revert"],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  return {
    cfg: {
      sre: { repoOwnership: { enabled: true, filePath: ownershipPath } },
    },
    runtimeRepo,
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("validateChangePlan", () => {
  it("accepts owned files in known repos", async () => {
    const { cfg } = await createFixture();
    const plan: ChangePlan = {
      version: "sre.change-plan.v1",
      planId: "plan:1",
      incidentId: "incident:1",
      summary: "fix runtime",
      status: "draft",
      generatedAt: "2026-03-08T00:00:00.000Z",
      repos: ["openclaw-sre"],
      steps: [
        {
          repoId: "openclaw-sre",
          summary: "patch runtime",
          ownedGlobs: ["src/**"],
          validationCommands: ["pnpm build"],
          files: ["src/example.ts"],
        },
      ],
      provenance: [],
    };
    await expect(validateChangePlan(plan, { config: cfg })).resolves.toEqual(plan);
  });

  it("rejects files outside owned paths", async () => {
    const { cfg } = await createFixture();
    const plan: ChangePlan = {
      version: "sre.change-plan.v1",
      planId: "plan:2",
      incidentId: "incident:2",
      summary: "bad fix",
      status: "draft",
      generatedAt: "2026-03-08T00:00:00.000Z",
      repos: ["openclaw-sre"],
      steps: [
        {
          repoId: "openclaw-sre",
          summary: "patch runtime",
          ownedGlobs: ["src/**"],
          validationCommands: ["pnpm build"],
          files: ["docs/nope.md"],
        },
      ],
      provenance: [],
    };
    await expect(validateChangePlan(plan, { config: cfg })).rejects.toThrow(/outside owned paths/);
  });
});
