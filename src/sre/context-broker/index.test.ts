import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runContextBroker } from "./index.js";

vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager: vi.fn(async () => ({
    manager: {
      search: vi.fn(async () => [
        {
          path: "memory/ops.md",
          snippet: "Previous rollout note",
          startLine: 1,
          endLine: 3,
        },
      ]),
    },
  })),
}));

const tempRoots: string[] = [];

async function createStateRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-context-broker-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("runContextBroker", () => {
  it("returns empty result when disabled", async () => {
    const result = await runContextBroker({
      config: { sre: { contextBroker: { enabled: false } } },
      prompt: "what did we do last time",
      agentId: "main",
    });

    expect(result.prependContext).toBeUndefined();
    expect(result.evidence).toEqual([]);
  });

  it("injects memory evidence for prior-work prompts", async () => {
    const result = await runContextBroker({
      config: { sre: { contextBroker: { enabled: true } } },
      prompt: "What did we do last time on this rollout?",
      agentId: "main",
      sessionKey: "agent:main:slack:user:u1",
    });

    expect(result.prependContext).toContain("Context broker:");
    expect(result.prependContext).toContain("[memory]");
  });

  it("injects repo ownership evidence for ownership prompts", async () => {
    const root = await createStateRoot();
    const ownershipPath = path.join(root, "state", "sre-index", "repo-ownership.json");
    await fs.mkdir(path.dirname(ownershipPath), { recursive: true });
    await fs.mkdir(path.join(root, "openclaw-sre"), { recursive: true });
    await fs.writeFile(
      ownershipPath,
      JSON.stringify(
        {
          version: "sre.repo-ownership-map.v1",
          generatedAt: "2026-03-07T00:00:00.000Z",
          repos: [
            {
              repoId: "openclaw-sre",
              githubRepo: "morpho-org/openclaw-sre",
              localPath: path.join(root, "openclaw-sre"),
              ownedGlobs: ["src/**"],
              sourceOfTruthDomains: ["runtime"],
              dependentRepos: [],
              ciChecks: [],
              validationCommands: [],
              rollbackHints: [],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runContextBroker({
      config: {
        sre: {
          contextBroker: { enabled: true },
          repoOwnership: { enabled: true, filePath: ownershipPath },
        },
      },
      prompt: "Which repo owns the runtime deployment fix?",
      agentId: "main",
    });

    expect(result.prependContext).toContain("[repo-ownership]");
    expect(result.prependContext).toContain("openclaw-sre");
  });
});
