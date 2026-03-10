import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * End-to-end integration test for the agent deploy pipeline.
 *
 * Tests the full flow: blueprint → config sync → workspace deploy,
 * including version upgrades and identity.emoji propagation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  deriveAllowAgents,
  buildConfigEntryFromManifest,
  detectDrift,
  applySync,
  type ConfigAgentEntry,
} from "./agent-config-sync.js";
import {
  loadBlueprint,
  deployAgent,
  deployAllAgents,
  readDeployedVersion,
  checkDeployStatus,
} from "./agent-workspace-deploy.js";
import { AgentManifestSchema } from "./zod-schema.agent-manifest.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "agent-e2e-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// Helper to create a complete agent blueprint directory
async function createAgentDir(baseDir: string, id: string, yaml: string, agentMd?: string) {
  const dir = join(baseDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "agent.yaml"), yaml, "utf-8");
  if (agentMd) {
    await writeFile(join(dir, "AGENT.md"), agentMd, "utf-8");
  }
  return dir;
}

describe("End-to-end deploy pipeline", () => {
  it("full pipeline: create blueprints → config sync → workspace deploy", async () => {
    const blueprintsDir = join(tmpDir, "agents");
    const workspacesDir = join(tmpDir, "workspaces");

    // Step 1: Create agent blueprints
    await createAgentDir(
      blueprintsDir,
      "ceo",
      [
        "id: ceo",
        "name: CEO",
        "tier: 1",
        "role: Chief Executive",
        "department: executive",
        "description: Top-level orchestrator",
        "version: 1.0.0",
        "identity:",
        '  emoji: "👑"',
      ].join("\n"),
      "# CEO\n\nYou are the Chief Executive.",
    );

    await createAgentDir(
      blueprintsDir,
      "vp-eng",
      [
        "id: vp-eng",
        "name: VP Engineering",
        "tier: 2",
        "role: VP of Engineering",
        "department: engineering",
        "description: Engineering lead",
        "version: 1.0.0",
        "identity:",
        '  emoji: "🔧"',
      ].join("\n"),
      "# VP Engineering\n\nYou lead the engineering team.",
    );

    await createAgentDir(
      blueprintsDir,
      "dev-a",
      [
        "id: dev-a",
        "name: Developer A",
        "tier: 3",
        "role: Developer",
        "department: engineering",
        "description: A developer",
        "version: 1.0.0",
        "requires: vp-eng",
        "identity:",
        '  emoji: "💻"',
        "tools:",
        "  allow:",
        "    - read",
        "    - write",
        "skills:",
        "  - coding-agent",
      ].join("\n"),
      "# Developer A\n\nYou are a developer specialist.",
    );

    // Create a bundle (should be skipped in deploy)
    await createAgentDir(
      blueprintsDir,
      "eng-pack",
      [
        "id: eng-pack",
        "name: Engineering Pack",
        "tier: 2",
        "role: Bundle",
        "department: engineering",
        "description: Engineering bundle",
        "version: 1.0.0",
        "is_bundle: true",
        "bundle_agents:",
        "  - vp-eng",
        "  - dev-a",
      ].join("\n"),
    );

    // Step 2: Validate all manifests
    const entries = await readdir(blueprintsDir, { withFileTypes: true });
    for (const entry of entries.filter((e) => e.isDirectory())) {
      const yaml = await readFile(join(blueprintsDir, entry.name, "agent.yaml"), "utf-8");
      const parsed = parseYaml(yaml);
      const result = AgentManifestSchema.safeParse(parsed);
      expect(
        result.success,
        `${entry.name} manifest invalid: ${JSON.stringify(result.error?.issues)}`,
      ).toBe(true);
    }

    // Step 3: Config sync — derive allow agents
    const allBlueprints = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const bp = await loadBlueprint(join(blueprintsDir, e.name));
          return bp!;
        }),
    );
    const manifests = allBlueprints.filter((b) => b !== null).map((b) => b.manifest);
    const nonBundles = manifests.filter((m) => !m.is_bundle);

    const allowMap = deriveAllowAgents(nonBundles);

    // CEO (T1) should have access to all T2 and T3
    expect(allowMap.get("ceo")).toContain("vp-eng");
    expect(allowMap.get("ceo")).toContain("dev-a");
    expect(allowMap.get("ceo")).toHaveLength(2);

    // VP Eng (T2) should have access to dev-a
    expect(allowMap.get("vp-eng")).toEqual(["dev-a"]);

    // Dev A (T3) has no subordinates
    expect(allowMap.get("dev-a")).toEqual([]);

    // Step 4: Build config entries from manifests
    const configEntries: ConfigAgentEntry[] = nonBundles.map((m) => {
      const allow = allowMap.get(m.id) ?? [];
      return buildConfigEntryFromManifest(m, allow);
    });

    // Verify identity.emoji propagated to config
    const ceoEntry = configEntries.find((e) => e.id === "ceo")!;
    expect(ceoEntry.identity?.emoji).toBe("👑");
    const devEntry = configEntries.find((e) => e.id === "dev-a")!;
    expect(devEntry.identity?.emoji).toBe("💻");

    // Step 5: Deploy workspaces
    const results = await deployAllAgents(blueprintsDir, (id) =>
      join(workspacesDir, `workspace-${id}`),
    );

    // 3 agents deployed, bundle skipped
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.isFirstDeploy)).toBe(true);

    // Verify SOUL.md contains AGENT.md content
    const ceoSoul = await readFile(join(workspacesDir, "workspace-ceo", "SOUL.md"), "utf-8");
    expect(ceoSoul).toContain("You are the Chief Executive");

    // Verify IDENTITY.md generated from manifest
    const devIdentity = await readFile(
      join(workspacesDir, "workspace-dev-a", "IDENTITY.md"),
      "utf-8",
    );
    expect(devIdentity).toContain("**Name:** Developer A");
    expect(devIdentity).toContain("**Emoji:** 💻");
    expect(devIdentity).toContain("**Reports to:** vp-eng");

    // Verify TOOLS.md generated
    const devTools = await readFile(join(workspacesDir, "workspace-dev-a", "TOOLS.md"), "utf-8");
    expect(devTools).toContain("- read");
    expect(devTools).toContain("- write");
    expect(devTools).toContain("- coding-agent");

    // Verify version tracking
    const ceoVersion = await readDeployedVersion(join(workspacesDir, "workspace-ceo"));
    expect(ceoVersion).toBe("1.0.0");
  });

  it("version upgrade flow: update blueprint → redeploy", async () => {
    const blueprintsDir = join(tmpDir, "agents");
    const workspaceDir = join(tmpDir, "workspace-agent-x");

    // Deploy v1
    await createAgentDir(
      blueprintsDir,
      "agent-x",
      [
        "id: agent-x",
        "name: Agent X",
        "tier: 2",
        "role: Lead",
        "department: ops",
        "description: V1 agent",
        "version: 1.0.0",
      ].join("\n"),
      "# Agent X v1\n\nVersion 1 instructions.",
    );

    let bp = await loadBlueprint(join(blueprintsDir, "agent-x"));
    let result = await deployAgent(bp!, workspaceDir);
    expect(result.isFirstDeploy).toBe(true);
    expect(result.version).toBe("1.0.0");

    let soul = await readFile(join(workspaceDir, "SOUL.md"), "utf-8");
    expect(soul).toContain("Version 1 instructions");

    // Write user file (should NOT be touched on upgrade)
    await writeFile(join(workspaceDir, "USER.md"), "My personal notes");
    // Modify HEARTBEAT.md (template-only, should NOT be overwritten)
    await writeFile(join(workspaceDir, "HEARTBEAT.md"), "Custom heartbeat");

    // Upgrade to v2
    await createAgentDir(
      blueprintsDir,
      "agent-x",
      [
        "id: agent-x",
        "name: Agent X",
        "tier: 2",
        "role: Senior Lead",
        "department: ops",
        "description: V2 agent with new capabilities",
        "version: 2.0.0",
        "identity:",
        '  emoji: "🚀"',
      ].join("\n"),
      "# Agent X v2\n\nVersion 2 with improved instructions.",
    );

    bp = await loadBlueprint(join(blueprintsDir, "agent-x"));
    result = await deployAgent(bp!, workspaceDir);
    expect(result.isUpgrade).toBe(true);
    expect(result.previousVersion).toBe("1.0.0");
    expect(result.version).toBe("2.0.0");

    // SOUL.md should be updated
    soul = await readFile(join(workspaceDir, "SOUL.md"), "utf-8");
    expect(soul).toContain("Version 2 with improved instructions");

    // IDENTITY.md should be updated with new emoji
    const identity = await readFile(join(workspaceDir, "IDENTITY.md"), "utf-8");
    expect(identity).toContain("**Emoji:** 🚀");
    expect(identity).toContain("**Role:** Senior Lead");

    // USER.md should be untouched
    const user = await readFile(join(workspaceDir, "USER.md"), "utf-8");
    expect(user).toBe("My personal notes");

    // HEARTBEAT.md should be untouched (template-only)
    const heartbeat = await readFile(join(workspaceDir, "HEARTBEAT.md"), "utf-8");
    expect(heartbeat).toBe("Custom heartbeat");

    // Version should be updated
    const version = await readDeployedVersion(workspaceDir);
    expect(version).toBe("2.0.0");
  });

  it("config drift detection and repair", async () => {
    const blueprintsDir = join(tmpDir, "agents");

    await createAgentDir(
      blueprintsDir,
      "lead",
      [
        "id: lead",
        "name: Lead",
        "tier: 2",
        "role: Team Lead",
        "department: ops",
        "description: Team lead",
        "version: 1.0.0",
      ].join("\n"),
    );

    await createAgentDir(
      blueprintsDir,
      "worker",
      [
        "id: worker",
        "name: Worker",
        "tier: 3",
        "role: Worker",
        "department: ops",
        "description: A worker",
        "version: 1.0.0",
        "requires: lead",
      ].join("\n"),
    );

    // Load manifests
    const bps = await Promise.all([
      loadBlueprint(join(blueprintsDir, "lead")),
      loadBlueprint(join(blueprintsDir, "worker")),
    ]);
    const manifests = bps.filter((b) => b !== null).map((b) => b.manifest);
    const derived = deriveAllowAgents(manifests);

    // Config has only lead, missing worker
    const configEntries: ConfigAgentEntry[] = [
      { id: "lead", name: "Lead", department: "ops", role: "Team Lead" },
    ];

    // Detect drift
    const drift = detectDrift(manifests, configEntries, derived);
    expect(drift.hasDrift).toBe(true);
    expect(drift.missingInConfig).toContain("worker");

    // Also detect incomplete allowAgents
    const leadIssue = drift.issues.find(
      (i) => i.agentId === "lead" && i.type === "allow_agents_incomplete",
    );
    expect(leadIssue).toBeDefined();

    // Apply sync
    const synced = applySync(manifests, configEntries, drift);
    expect(synced).toHaveLength(2);

    const workerEntry = synced.find((e) => e.id === "worker");
    expect(workerEntry).toBeDefined();
    expect(workerEntry!.department).toBe("ops");

    const leadEntry = synced.find((e) => e.id === "lead");
    expect(leadEntry!.subagents?.allowAgents).toEqual(["worker"]);

    // Re-check drift after sync — should be clean
    const postDrift = detectDrift(manifests, synced, derived);
    expect(postDrift.hasDrift).toBe(false);
  });

  it("idempotent deploy — no changes when version matches", async () => {
    const blueprintsDir = join(tmpDir, "agents");
    const workspaceDir = join(tmpDir, "workspace-idempotent");

    await createAgentDir(
      blueprintsDir,
      "stable",
      [
        "id: stable",
        "name: Stable",
        "tier: 2",
        "role: Lead",
        "department: ops",
        "description: Stable agent",
        "version: 1.0.0",
      ].join("\n"),
      "# Stable Agent",
    );

    const bp = await loadBlueprint(join(blueprintsDir, "stable"));

    // First deploy
    const r1 = await deployAgent(bp!, workspaceDir);
    expect(r1.isFirstDeploy).toBe(true);
    expect(r1.filesWritten.length).toBeGreaterThan(0);

    // Second deploy — should be no-op
    const r2 = await deployAgent(bp!, workspaceDir);
    expect(r2.isFirstDeploy).toBe(false);
    expect(r2.isUpgrade).toBe(false);
    expect(r2.filesWritten).toHaveLength(0);

    // checkDeployStatus should confirm up-to-date
    const status = await checkDeployStatus(bp!, workspaceDir);
    expect(status.deployed).toBe(true);
    expect(status.needsUpgrade).toBe(false);
  });
});
