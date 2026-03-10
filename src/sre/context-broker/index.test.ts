import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
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
      agentId: "sre-verifier",
      sessionKey: "agent:sre-verifier:slack:user:u1",
    });

    expect(result.prependContext).toContain("Context broker packet:");
    expect(result.prependContext).toContain("Prior work:");
    expect(result.prependContext).toContain("memory/ops.md");
  });

  it("returns empty result for ordinary sessions even when enabled", async () => {
    const result = await runContextBroker({
      config: {
        sre: {
          contextBroker: { enabled: true },
          incidentDossier: { enabled: true },
          relationshipIndex: { enabled: true },
          repoOwnership: { enabled: true },
        },
      },
      prompt: "Which repo owns the runtime deployment fix from the incident?",
      agentId: "main",
      sessionKey: "agent:main:slack:user:u1",
    });

    expect(result.prependContext).toBeUndefined();
    expect(result.evidence).toEqual([]);
    expect(result.intents).toEqual([]);
    expect(result.reasons).toEqual([]);
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
          relationshipIndex: { enabled: true },
          repoOwnership: { enabled: true, filePath: ownershipPath },
        },
      },
      prompt: "Which repo owns the runtime deployment fix?",
      agentId: "sre-repo-runtime",
    });

    expect(result.prependContext).toContain("Repo ownership:");
    expect(result.prependContext).toContain("openclaw-sre");
  });

  it("injects graph-neighbor evidence for incident follow-up prompts", async () => {
    const root = await createStateRoot();
    const graphDir = path.join(root, "state", "sre-graph");
    await fs.mkdir(graphDir, { recursive: true });
    await fs.writeFile(
      path.join(graphDir, "latest-by-entity.json"),
      JSON.stringify(
        {
          version: "sre.relationship-index-latest.v1",
          updatedAt: "2026-03-10T17:00:00.000Z",
          nodes: {
            "incident:redis-spike": {
              version: "sre.relationship-index-node.v1",
              entityId: "incident:redis-spike",
              entityType: "incident",
              observedAt: "2026-03-10T17:00:00.000Z",
              attributes: {
                service: "blue-api",
                summary: "redis saturation incident",
              },
            },
            "repo:morpho-org/openclaw-sre": {
              version: "sre.relationship-index-node.v1",
              entityId: "repo:morpho-org/openclaw-sre",
              entityType: "repo",
              observedAt: "2026-03-10T17:00:00.000Z",
              attributes: {
                owner: "runtime-team",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(graphDir, "edges.ndjson"),
      `{"broken": }\n${JSON.stringify({
        version: "sre.relationship-edge.v1",
        edgeId: "edge:incident-repo",
        from: "incident:redis-spike",
        to: "repo:morpho-org/openclaw-sre",
        edgeType: "references",
        discoveredAt: "2026-03-10T17:00:00.000Z",
        provenance: [
          {
            version: "sre.provenance-ref.v1",
            artifactType: "timeline_event",
            source: "runtime-hook:test",
            locator: "test://incident-repo",
            capturedAt: "2026-03-10T17:00:00.000Z",
          },
        ],
      })}\n`,
      "utf8",
    );

    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const result = await runContextBroker({
        config: {
          sre: {
            contextBroker: { enabled: true },
            relationshipIndex: { enabled: true },
          },
        },
        prompt: "Follow up on the redis saturation incident and related repo",
        agentId: "sre-verifier",
      });

      expect(result.prependContext).toContain("incident:redis-spike");
      expect(result.prependContext).toContain("references");
      expect(result.prependContext).toContain("repo:morpho-org/openclaw-sre");
    });
  });

  it("falls back to shell relationship knowledge cache when runtime graph is empty", async () => {
    const root = await createStateRoot();
    const incidentStateDir = path.join(root, "state", "sentinel");
    await fs.mkdir(incidentStateDir, { recursive: true });
    await fs.writeFile(
      path.join(incidentStateDir, "relationship-knowledge-cache.json"),
      JSON.stringify(
        {
          metadata: {
            schema: "initial-knowledge.v1",
          },
          nodes: [
            {
              id: "repo:morpho-org/morpho-infra-helm",
              type: "github_repository",
              name: "morpho-org/morpho-infra-helm",
            },
          ],
          edges: [
            {
              id: "edge:1",
              source: "image-repo:openclaw-sre",
              type: "defined_in",
              target: "repo:morpho-org/morpho-infra-helm",
              notes: "helm release config",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    await withEnvAsync(
      { OPENCLAW_STATE_DIR: root, INCIDENT_STATE_DIR: incidentStateDir },
      async () => {
        const result = await runContextBroker({
          config: {
            sre: {
              contextBroker: { enabled: true },
              relationshipIndex: { enabled: true },
            },
          },
          prompt: "Which repo and image relationship explains the helm release config?",
          agentId: "sre-verifier",
        });

        expect(result.prependContext).toContain("Shell relationship knowledge:");
        expect(result.prependContext).toContain("morpho-org/morpho-infra-helm");
      },
    );
  });

  it("requires the repo ownership flag before loading ownership evidence", async () => {
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
          repoOwnership: { enabled: false, filePath: ownershipPath },
        },
      },
      prompt: "Which repo owns the runtime deployment fix?",
      agentId: "sre-repo-runtime",
    });

    expect(result.prependContext).toBeUndefined();
    expect(result.evidence).toEqual([]);
  });
});
