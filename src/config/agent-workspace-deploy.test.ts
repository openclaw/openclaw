import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Agent workspace deploy engine tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  generateSoulMd,
  generateIdentityMd,
  generateToolsMd,
  generateHeartbeatMd,
  loadBlueprint,
  deployAgent,
  deployAllAgents,
  readDeployedVersion,
  checkDeployStatus,
} from "./agent-workspace-deploy.js";
import type { AgentManifest } from "./zod-schema.agent-manifest.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeManifest(overrides: Partial<AgentManifest> & { id: string }): AgentManifest {
  return {
    name: overrides.id,
    tier: 3,
    role: "Test Agent",
    department: "engineering",
    description: "A test agent for testing",
    version: "1.0.0",
    ...overrides,
  } as AgentManifest;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "agent-deploy-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Generator tests ──────────────────────────────────────────────────────────

describe("generateSoulMd", () => {
  it("uses AGENT.md content when provided", () => {
    const manifest = makeManifest({ id: "neo", name: "Neo", role: "CTO" });
    const agentMd = "# Neo — CTO\n\nYou are Neo.";
    const result = generateSoulMd(manifest, agentMd);
    expect(result).toBe(agentMd);
  });

  it("generates fallback from manifest when no AGENT.md", () => {
    const manifest = makeManifest({
      id: "neo",
      name: "Neo",
      role: "CTO",
      capabilities: ["code_review", "architecture_decisions"],
    });
    const result = generateSoulMd(manifest, null);
    expect(result).toContain("# Neo — CTO");
    expect(result).toContain("A test agent for testing");
    expect(result).toContain("code review");
    expect(result).toContain("architecture decisions");
  });
});

describe("generateIdentityMd", () => {
  it("includes all manifest fields", () => {
    const manifest = makeManifest({
      id: "tank",
      name: "Tank",
      role: "Backend Engineer",
      department: "engineering",
      requires: "neo",
      identity: { emoji: "🛡️" },
    });
    const result = generateIdentityMd(manifest);
    expect(result).toContain("# IDENTITY.md — Tank");
    expect(result).toContain("**Name:** Tank");
    expect(result).toContain("**Role:** Backend Engineer");
    expect(result).toContain("**Department:** engineering");
    expect(result).toContain("**Emoji:** 🛡️");
    expect(result).toContain("**Reports to:** neo");
  });

  it("omits optional fields when not set", () => {
    const manifest = makeManifest({ id: "neo", name: "Neo", tier: 2, role: "CTO" });
    const result = generateIdentityMd(manifest);
    expect(result).not.toContain("Reports to");
    expect(result).not.toContain("Emoji");
  });
});

describe("generateToolsMd", () => {
  it("lists allowed and denied tools", () => {
    const manifest = makeManifest({
      id: "neo",
      name: "Neo",
      tools: { allow: ["read", "write"], deny: ["exec"] },
      skills: ["coding-agent"],
      routing_hints: { keywords: ["backend", "api"] },
    });
    const result = generateToolsMd(manifest);
    expect(result).toContain("## Allowed Tools");
    expect(result).toContain("- read");
    expect(result).toContain("- write");
    expect(result).toContain("## Denied Tools");
    expect(result).toContain("- exec");
    expect(result).toContain("## Skills");
    expect(result).toContain("- coding-agent");
    expect(result).toContain("## Routing Keywords");
    expect(result).toContain("backend, api");
  });
});

describe("generateHeartbeatMd", () => {
  it("generates heartbeat template with agent name", () => {
    const manifest = makeManifest({ id: "neo", name: "Neo" });
    const result = generateHeartbeatMd(manifest);
    expect(result).toContain("# HEARTBEAT.md — Neo");
    expect(result).toContain("Quick Status");
  });
});

// ── Blueprint loading tests ─────────────────────────────────────────────────

describe("loadBlueprint", () => {
  it("loads a valid blueprint directory", async () => {
    const agentDir = join(tmpDir, "neo");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "agent.yaml"),
      [
        "id: neo",
        "name: Neo",
        "tier: 2",
        "role: CTO",
        "department: engineering",
        "description: Chief Technology Officer",
        "version: 1.0.0",
      ].join("\n"),
    );
    await writeFile(join(agentDir, "AGENT.md"), "# Neo\n\nYou are Neo.");

    const blueprint = await loadBlueprint(agentDir);
    expect(blueprint).not.toBeNull();
    expect(blueprint!.manifest.id).toBe("neo");
    expect(blueprint!.agentMd).toBe("# Neo\n\nYou are Neo.");
  });

  it("loads blueprint without AGENT.md", async () => {
    const agentDir = join(tmpDir, "neo");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "agent.yaml"),
      [
        "id: neo",
        "name: Neo",
        "tier: 2",
        "role: CTO",
        "department: engineering",
        "description: Chief Technology Officer",
        "version: 1.0.0",
      ].join("\n"),
    );

    const blueprint = await loadBlueprint(agentDir);
    expect(blueprint).not.toBeNull();
    expect(blueprint!.agentMd).toBeNull();
  });

  it("returns null for invalid yaml", async () => {
    const agentDir = join(tmpDir, "bad");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "agent.yaml"), "{{invalid");

    const blueprint = await loadBlueprint(agentDir);
    expect(blueprint).toBeNull();
  });

  it("returns null for missing directory", async () => {
    const blueprint = await loadBlueprint(join(tmpDir, "nonexistent"));
    expect(blueprint).toBeNull();
  });
});

// ── Deploy tests ─────────────────────────────────────────────────────────────

describe("deployAgent", () => {
  it("deploys a first-time agent", async () => {
    const manifest = makeManifest({
      id: "test-agent-x",
      name: "TestAgentX",
      role: "CTO",
      department: "engineering",
      identity: { emoji: "🔮" },
      tools: { allow: ["read", "write"] },
      skills: ["coding-agent"],
    });
    const blueprint = {
      manifest,
      agentMd: "# TestAgentX\n\nYou are TestAgentX.",
      blueprintDir: tmpDir,
    };
    const workspaceDir = join(tmpDir, "workspace-test-agent-x");

    const result = await deployAgent(blueprint, workspaceDir);

    expect(result.isFirstDeploy).toBe(true);
    expect(result.isUpgrade).toBe(false);
    expect(result.previousVersion).toBeNull();
    expect(result.version).toBe("1.0.0");
    expect(result.filesWritten).toContain("SOUL.md");
    expect(result.filesWritten).toContain("IDENTITY.md");
    expect(result.filesWritten).toContain("TOOLS.md");
    expect(result.filesWritten).toContain("HEARTBEAT.md");

    // Verify files on disk
    const soul = await readFile(join(workspaceDir, "SOUL.md"), "utf-8");
    expect(soul).toContain("You are TestAgentX");

    const identity = await readFile(join(workspaceDir, "IDENTITY.md"), "utf-8");
    expect(identity).toContain("**Emoji:** 🔮");

    const tools = await readFile(join(workspaceDir, "TOOLS.md"), "utf-8");
    expect(tools).toContain("- read");

    const version = await readDeployedVersion(workspaceDir);
    expect(version).toBe("1.0.0");
  });

  it("skips deploy when version matches", async () => {
    const manifest = makeManifest({ id: "test-skip", name: "TestSkip", role: "CTO" });
    const blueprint = { manifest, agentMd: null, blueprintDir: tmpDir };
    const workspaceDir = join(tmpDir, "workspace-test-skip");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, ".agent-version"), "1.0.0\n");

    const result = await deployAgent(blueprint, workspaceDir);

    expect(result.isFirstDeploy).toBe(false);
    expect(result.isUpgrade).toBe(false);
    expect(result.filesWritten).toHaveLength(0);
    expect(result.filesSkipped.length).toBeGreaterThan(0);
  });

  it("upgrades when version changes", async () => {
    const manifest = makeManifest({
      id: "test-upgrade",
      name: "TestUpgrade",
      role: "CTO",
      version: "2.0.0",
    } as AgentManifest & { id: string });
    const blueprint = { manifest, agentMd: "# TestUpgrade v2\n\nUpgraded.", blueprintDir: tmpDir };
    const workspaceDir = join(tmpDir, "workspace-test-upgrade");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, ".agent-version"), "1.0.0\n");
    // Pre-existing user file should not be touched
    await writeFile(join(workspaceDir, "USER.md"), "My preferences");

    const result = await deployAgent(blueprint, workspaceDir);

    expect(result.isUpgrade).toBe(true);
    expect(result.previousVersion).toBe("1.0.0");
    expect(result.version).toBe("2.0.0");
    expect(result.filesWritten).toContain("SOUL.md");
    expect(result.filesWritten).toContain("IDENTITY.md");
    expect(result.filesWritten).toContain("TOOLS.md");
    // Template-only files NOT overwritten on upgrade
    expect(result.filesWritten).not.toContain("HEARTBEAT.md");
    // Never-touch files skipped
    expect(result.filesSkipped).toContain("USER.md");

    // Verify version updated
    const version = await readDeployedVersion(workspaceDir);
    expect(version).toBe("2.0.0");

    // Verify user file untouched
    const user = await readFile(join(workspaceDir, "USER.md"), "utf-8");
    expect(user).toBe("My preferences");
  });

  it("force deploys even when version matches", async () => {
    const manifest = makeManifest({ id: "test-force", name: "TestForce", role: "CTO" });
    const blueprint = { manifest, agentMd: null, blueprintDir: tmpDir };
    const workspaceDir = join(tmpDir, "workspace-test-force");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, ".agent-version"), "1.0.0\n");

    const result = await deployAgent(blueprint, workspaceDir, { force: true });

    expect(result.filesWritten).toContain("SOUL.md");
    expect(result.filesWritten).toContain("IDENTITY.md");
    expect(result.filesWritten).toContain("TOOLS.md");
  });

  it("dry run does not write files", async () => {
    const manifest = makeManifest({ id: "test-dry", name: "TestDry", role: "CTO" });
    const blueprint = { manifest, agentMd: "# TestDry", blueprintDir: tmpDir };
    const workspaceDir = join(tmpDir, "workspace-test-dry");

    const result = await deployAgent(blueprint, workspaceDir, { dryRun: true });

    expect(result.filesWritten).toContain("SOUL.md");
    // But directory should not exist
    const entries = await readdir(tmpDir);
    expect(entries).not.toContain("workspace-test-dry");
  });

  it("does not overwrite template-only files on upgrade", async () => {
    const manifest = makeManifest({
      id: "test-tmpl",
      name: "TestTmpl",
      role: "CTO",
      version: "2.0.0",
    } as AgentManifest & { id: string });
    const blueprint = { manifest, agentMd: null, blueprintDir: tmpDir };
    const workspaceDir = join(tmpDir, "workspace-test-tmpl");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, ".agent-version"), "1.0.0\n");
    await writeFile(join(workspaceDir, "HEARTBEAT.md"), "Custom heartbeat content");

    const result = await deployAgent(blueprint, workspaceDir);

    // HEARTBEAT.md should not be in filesWritten
    expect(result.filesWritten).not.toContain("HEARTBEAT.md");
    expect(result.filesSkipped).toContain("HEARTBEAT.md");

    // Verify original content preserved
    const heartbeat = await readFile(join(workspaceDir, "HEARTBEAT.md"), "utf-8");
    expect(heartbeat).toBe("Custom heartbeat content");
  });
});

// ── Matrix template integration ──────────────────────────────────────────────

describe("matrix template integration", () => {
  it("uses matrix template when available", async () => {
    // Create a matrix template directory
    const templateDir = join(tmpDir, "templates");
    const matrixDir = join(templateDir, "matrix", "neo");
    await mkdir(matrixDir, { recursive: true });
    await writeFile(
      join(matrixDir, "IDENTITY.md"),
      [
        "---",
        'summary: "Neo identity"',
        "---",
        "",
        "# IDENTITY.md — Neo (Matrix)",
        "",
        "Custom matrix identity content.",
      ].join("\n"),
    );

    const manifest = makeManifest({ id: "neo", name: "Neo", role: "CTO" });
    const blueprint = { manifest, agentMd: null, blueprintDir: tmpDir };
    const workspaceDir = join(tmpDir, "workspace-neo");

    const result = await deployAgent(blueprint, workspaceDir, {}, templateDir);

    expect(result.filesWritten).toContain("IDENTITY.md");
    const identity = await readFile(join(workspaceDir, "IDENTITY.md"), "utf-8");
    // Frontmatter should be stripped
    expect(identity).not.toContain("---");
    expect(identity).toContain("Neo (Matrix)");
    expect(identity).toContain("Custom matrix identity content");
  });
});

// ── deployAllAgents ──────────────────────────────────────────────────────────

describe("deployAllAgents", () => {
  it("deploys all non-bundle agents", async () => {
    // Create two agent dirs and one bundle
    const blueprintsDir = join(tmpDir, "agents");

    const neoDir = join(blueprintsDir, "neo");
    await mkdir(neoDir, { recursive: true });
    await writeFile(
      join(neoDir, "agent.yaml"),
      [
        "id: neo",
        "name: Neo",
        "tier: 2",
        "role: CTO",
        "department: engineering",
        "description: CTO",
        "version: 1.0.0",
      ].join("\n"),
    );
    await writeFile(join(neoDir, "AGENT.md"), "# Neo");

    const tankDir = join(blueprintsDir, "tank");
    await mkdir(tankDir, { recursive: true });
    await writeFile(
      join(tankDir, "agent.yaml"),
      [
        "id: tank",
        "name: Tank",
        "tier: 3",
        "role: Backend",
        "department: engineering",
        "description: Backend dev",
        "version: 1.0.0",
        "requires: neo",
      ].join("\n"),
    );

    const bundleDir = join(blueprintsDir, "eng-pack");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      join(bundleDir, "agent.yaml"),
      [
        "id: eng-pack",
        "name: Eng Pack",
        "tier: 2",
        "role: Bundle",
        "department: engineering",
        "description: Bundle",
        "version: 1.0.0",
        "is_bundle: true",
        "bundle_agents:",
        "  - neo",
        "  - tank",
      ].join("\n"),
    );

    const workspacesDir = join(tmpDir, "workspaces");
    const results = await deployAllAgents(blueprintsDir, (id) =>
      join(workspacesDir, `workspace-${id}`),
    );

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.agentId).toSorted()).toEqual(["neo", "tank"]);
    // Bundle should not be deployed
    expect(results.find((r) => r.agentId === "eng-pack")).toBeUndefined();
  });
});

// ── checkDeployStatus ────────────────────────────────────────────────────────

describe("checkDeployStatus", () => {
  it("reports undeployed status", async () => {
    const manifest = makeManifest({ id: "test-status-a", name: "TestA" });
    const blueprint = { manifest, agentMd: null, blueprintDir: tmpDir };
    const workspaceDir = join(tmpDir, "workspace-test-status-a");

    const status = await checkDeployStatus(blueprint, workspaceDir);
    expect(status.deployed).toBe(false);
    expect(status.currentVersion).toBeNull();
    expect(status.needsUpgrade).toBe(false);
    expect(status.workspaceExists).toBe(false);
  });

  it("reports deployed and up-to-date", async () => {
    const manifest = makeManifest({ id: "test-status-b", name: "TestB" });
    const blueprint = { manifest, agentMd: null, blueprintDir: tmpDir };
    const workspaceDir = join(tmpDir, "workspace-test-status-b");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, ".agent-version"), "1.0.0\n");

    const status = await checkDeployStatus(blueprint, workspaceDir);
    expect(status.deployed).toBe(true);
    expect(status.currentVersion).toBe("1.0.0");
    expect(status.needsUpgrade).toBe(false);
    expect(status.workspaceExists).toBe(true);
  });

  it("reports needs upgrade", async () => {
    const manifest = makeManifest({
      id: "test-status-c",
      name: "TestC",
      version: "2.0.0",
    } as AgentManifest & { id: string });
    const blueprint = { manifest, agentMd: null, blueprintDir: tmpDir };
    const workspaceDir = join(tmpDir, "workspace-test-status-c");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, ".agent-version"), "1.0.0\n");

    const status = await checkDeployStatus(blueprint, workspaceDir);
    expect(status.deployed).toBe(true);
    expect(status.currentVersion).toBe("1.0.0");
    expect(status.manifestVersion).toBe("2.0.0");
    expect(status.needsUpgrade).toBe(true);
  });
});
