import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { wrapToolWithOwnedPathPolicy } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

const tempRoots: string[] = [];

async function createCaseRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-owned-paths-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createOwnershipConfig(root: string): Promise<OpenClawConfig> {
  const runtimeRepo = path.join(root, "openclaw-sre");
  const helmRepo = path.join(root, "morpho-infra-helm");
  await fs.mkdir(path.join(runtimeRepo, "src"), { recursive: true });
  await fs.mkdir(path.join(helmRepo, "charts", "openclaw-sre"), { recursive: true });
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
            dependentRepos: ["morpho-infra-helm"],
            ciChecks: ["pnpm build"],
            validationCommands: ["pnpm build"],
            rollbackHints: ["revert"],
          },
          {
            repoId: "morpho-infra-helm",
            localPath: helmRepo,
            ownedGlobs: ["charts/openclaw-sre/**"],
            sourceOfTruthDomains: ["helm"],
            dependentRepos: ["openclaw-sre"],
            ciChecks: ["helm template"],
            validationCommands: ["helm lint"],
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
    sre: {
      repoOwnership: { filePath: ownershipPath, enabled: true },
    },
  };
}

describe("owned path tool policy", () => {
  it("allows fixer writes inside owned globs and blocks outside them", async () => {
    const root = await createCaseRoot();
    const runtimeRepo = path.join(root, "openclaw-sre");
    const config = await createOwnershipConfig(root);
    const baseTool: AnyAgentTool = {
      name: "write",
      label: "write",
      description: "write",
      parameters: {} as never,
      execute: vi.fn(async () => ({ content: [], details: {} })),
    };
    const tool = wrapToolWithOwnedPathPolicy({
      tool: baseTool,
      agentId: "sre-repo-runtime",
      config,
      workspaceRoot: runtimeRepo,
    });

    await expect(
      tool.execute("call-1", { path: "src/ok.ts", content: "ok" }),
    ).resolves.toBeDefined();
    await expect(tool.execute("call-2", { path: "docs/nope.md", content: "no" })).rejects.toThrow(
      /Owned-path policy blocked/,
    );
  });

  it("blocks mutating exec for read-only agents", async () => {
    const root = await createCaseRoot();
    const runtimeRepo = path.join(root, "openclaw-sre");
    const config = await createOwnershipConfig(root);
    const execTool: AnyAgentTool = {
      name: "exec",
      label: "exec",
      description: "exec",
      parameters: {} as never,
      execute: vi.fn(async () => ({ content: [], details: {} })),
    };
    const tool = wrapToolWithOwnedPathPolicy({
      tool: execTool,
      agentId: "sre-verifier",
      config,
      workspaceRoot: runtimeRepo,
    });

    await expect(tool.execute("call-3", { command: "touch /tmp/pwned" })).rejects.toThrow(
      /Read-only agent cannot run mutating exec/,
    );
  });
});
