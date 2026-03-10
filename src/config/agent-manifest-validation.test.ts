/**
 * Agent marketplace manifest validation tests.
 *
 * Validates all bundled agents against the AgentManifestSchema, checks
 * AGENT.md format, and verifies tier dependency chains.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  validateAgentMd,
  validateManifestYaml,
  validateTierDependencies,
  findDependents,
  canInstall,
  loadAgentFromDir,
} from "./agent-manifest-validation.js";
import { AgentManifestSchema, type AgentManifest } from "./zod-schema.agent-manifest.js";

// ── Bundled agents directory ─────────────────────────────────────────────────

const AGENTS_DIR = join(import.meta.dirname, "..", "..", "agents");

async function loadAllBundledAgents(): Promise<
  { id: string; manifest: AgentManifest; dir: string }[]
> {
  const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
  const agents: { id: string; manifest: AgentManifest; dir: string }[] = [];
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const dir = join(AGENTS_DIR, entry.name);
    const yaml = await readFile(join(dir, "agent.yaml"), "utf-8");
    const parsed = parseYaml(yaml);
    const result = AgentManifestSchema.safeParse(parsed);
    if (result.success) {
      agents.push({ id: result.data.id, manifest: result.data, dir });
    }
  }
  return agents;
}

// ── Schema validation tests ──────────────────────────────────────────────────

describe("Bundled agent.yaml schema validation", () => {
  test("all bundled agents pass AgentManifestSchema validation", async () => {
    const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());

    // Count agents vs bundles separately for clarity
    const agentDirs: string[] = [];
    const bundleDirs: string[] = [];
    for (const entry of dirs) {
      const yaml = await readFile(join(AGENTS_DIR, entry.name, "agent.yaml"), "utf-8");
      if (yaml.includes("is_bundle: true")) {
        bundleDirs.push(entry.name);
      } else {
        agentDirs.push(entry.name);
      }
    }

    // 13 real agents (operator1 + 3 dept heads + 9 specialists)
    expect(agentDirs.length).toBeGreaterThanOrEqual(13);
    // At least 1 bundle exists
    expect(bundleDirs.length).toBeGreaterThanOrEqual(1);

    for (const entry of dirs) {
      const dir = join(AGENTS_DIR, entry.name);
      const yaml = await readFile(join(dir, "agent.yaml"), "utf-8");
      const result = validateManifestYaml(yaml);
      expect(result.valid, `${entry.name}/agent.yaml: ${result.errors.join(", ")}`).toBe(true);
      expect(result.manifest).toBeDefined();
    }
  });

  test("all required fields present on every agent", async () => {
    const agents = await loadAllBundledAgents();
    for (const { id, manifest } of agents) {
      expect(manifest.id, `${id} missing id`).toBeTruthy();
      expect(manifest.name, `${id} missing name`).toBeTruthy();
      expect(manifest.tier, `${id} missing tier`).toBeGreaterThanOrEqual(1);
      expect(manifest.tier, `${id} tier out of range`).toBeLessThanOrEqual(3);
      expect(manifest.role, `${id} missing role`).toBeTruthy();
      expect(manifest.department, `${id} missing department`).toBeTruthy();
      expect(manifest.description, `${id} missing description`).toBeTruthy();
      expect(manifest.version, `${id} missing version`).toMatch(/^\d+\.\d+\.\d+$/);
      // All non-bundle agents should have identity.emoji
      if (!manifest.is_bundle) {
        expect(manifest.identity?.emoji, `${id} missing identity.emoji`).toBeTruthy();
      }
    }
  });
});

// ── AGENT.md validation tests ────────────────────────────────────────────────

describe("Bundled AGENT.md format validation", () => {
  test("all bundled agents have AGENT.md files", async () => {
    const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
    for (const entry of entries.filter((e) => e.isDirectory())) {
      // Skip bundles — they are meta-packages with no agent instructions
      try {
        const yaml = await readFile(join(AGENTS_DIR, entry.name, "agent.yaml"), "utf-8");
        if (yaml.includes("is_bundle: true")) {
          continue;
        }
      } catch {
        /* no yaml = not a bundle */
      }
      const mdPath = join(AGENTS_DIR, entry.name, "AGENT.md");
      const content = await readFile(mdPath, "utf-8");
      expect(content.length, `${entry.name}/AGENT.md is empty`).toBeGreaterThan(0);
    }
  });

  test("no AGENT.md has YAML frontmatter", async () => {
    const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
    for (const entry of entries.filter((e) => e.isDirectory())) {
      // Skip bundles
      try {
        const yaml = await readFile(join(AGENTS_DIR, entry.name, "agent.yaml"), "utf-8");
        if (yaml.includes("is_bundle: true")) {
          continue;
        }
      } catch {
        /* no yaml = not a bundle */
      }
      const mdPath = join(AGENTS_DIR, entry.name, "AGENT.md");
      const content = await readFile(mdPath, "utf-8");
      const result = validateAgentMd(content);
      expect(result.valid, `${entry.name}/AGENT.md has frontmatter`).toBe(true);
    }
  });
});

// ── Tier enforcement tests ───────────────────────────────────────────────────

describe("Tier hierarchy validation", () => {
  test("operator1 is tier 1 (core)", async () => {
    const agents = await loadAllBundledAgents();
    const op1 = agents.find((a) => a.id === "operator1");
    expect(op1).toBeDefined();
    expect(op1!.manifest.tier).toBe(1);
    expect(op1!.manifest.requires).toBeFalsy();
  });

  test("department heads are tier 2", async () => {
    const agents = await loadAllBundledAgents();
    const tier2Ids = ["neo", "trinity", "morpheus"];
    for (const id of tier2Ids) {
      const agent = agents.find((a) => a.id === id);
      expect(agent, `${id} not found`).toBeDefined();
      expect(agent!.manifest.tier, `${id} should be tier 2`).toBe(2);
    }
  });

  test("specialists are tier 3 with correct parent", async () => {
    const agents = await loadAllBundledAgents();
    const expectedParents: Record<string, string> = {
      tank: "neo",
      dozer: "neo",
      mouse: "neo",
      oracle: "trinity",
      seraph: "trinity",
      zee: "trinity",
      niobe: "morpheus",
      switch: "morpheus",
      rex: "morpheus",
    };

    for (const [id, expectedParent] of Object.entries(expectedParents)) {
      const agent = agents.find((a) => a.id === id);
      expect(agent, `${id} not found`).toBeDefined();
      expect(agent!.manifest.tier, `${id} should be tier 3`).toBe(3);
      expect(agent!.manifest.requires, `${id} should require ${expectedParent}`).toBe(
        expectedParent,
      );
    }
  });

  test("tier dependencies are valid across all bundled agents", async () => {
    const agents = await loadAllBundledAgents();
    const manifests = agents.map((a) => a.manifest);
    const result = validateTierDependencies(manifests);
    expect(result.valid, `Tier dependency errors: ${result.errors.join(", ")}`).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── Dependency helper tests ──────────────────────────────────────────────────

describe("findDependents", () => {
  test("neo has specialist dependents", async () => {
    const agents = await loadAllBundledAgents();
    const manifests = agents.map((a) => a.manifest);
    const deps = findDependents("neo", manifests);
    const depIds = deps.map((d) => d.id).toSorted();
    // Original 3 + new engineering specialists
    expect(depIds).toContain("dozer");
    expect(depIds).toContain("mouse");
    expect(depIds).toContain("tank");
    expect(depIds).toContain("spark");
    expect(depIds).toContain("cipher");
    expect(depIds).toContain("relay");
    expect(depIds).toContain("ghost");
    expect(depIds).toContain("binary");
    expect(depIds).toContain("kernel");
    expect(depIds).toContain("prism");
    expect(depIds).toHaveLength(10);
  });

  test("trinity has specialist dependents", async () => {
    const agents = await loadAllBundledAgents();
    const manifests = agents.map((a) => a.manifest);
    const deps = findDependents("trinity", manifests);
    const depIds = deps.map((d) => d.id).toSorted();
    // Original 3 + new finance specialists
    expect(depIds).toContain("oracle");
    expect(depIds).toContain("seraph");
    expect(depIds).toContain("zee");
    expect(depIds).toContain("ledger");
    expect(depIds).toContain("vault");
    expect(depIds).toContain("shield");
    expect(depIds).toContain("trace");
    expect(depIds).toContain("quota");
    expect(depIds).toContain("merit");
    expect(depIds).toContain("beacon");
    expect(depIds).toHaveLength(10);
  });

  test("morpheus has specialist dependents", async () => {
    const agents = await loadAllBundledAgents();
    const manifests = agents.map((a) => a.manifest);
    const deps = findDependents("morpheus", manifests);
    const depIds = deps.map((d) => d.id).toSorted();
    // Original 3 + new marketing specialists
    expect(depIds).toContain("niobe");
    expect(depIds).toContain("rex");
    expect(depIds).toContain("switch");
    expect(depIds).toContain("ink");
    expect(depIds).toContain("vibe");
    expect(depIds).toContain("lens");
    expect(depIds).toContain("echo");
    expect(depIds).toContain("nova");
    expect(depIds).toContain("pulse");
    expect(depIds).toContain("blaze");
    expect(depIds).toHaveLength(10);
  });

  test("tier 3 agents have no dependents", async () => {
    const agents = await loadAllBundledAgents();
    const manifests = agents.map((a) => a.manifest);
    const tier3 = agents.filter((a) => a.manifest.tier === 3);
    for (const agent of tier3) {
      const deps = findDependents(agent.id, manifests);
      expect(deps, `${agent.id} should have no dependents`).toHaveLength(0);
    }
  });
});

describe("canInstall", () => {
  test("tier 2 agent can install independently", async () => {
    const agents = await loadAllBundledAgents();
    const neo = agents.find((a) => a.id === "neo")!;
    const result = canInstall(neo.manifest, []);
    expect(result.ok).toBe(true);
  });

  test("tier 3 agent fails without parent", async () => {
    const agents = await loadAllBundledAgents();
    const tank = agents.find((a) => a.id === "tank")!;
    const result = canInstall(tank.manifest, []);
    expect(result.ok).toBe(false);
    expect(result.missingDep).toBe("neo");
  });

  test("tier 3 agent succeeds with parent installed", async () => {
    const agents = await loadAllBundledAgents();
    const neo = agents.find((a) => a.id === "neo")!;
    const tank = agents.find((a) => a.id === "tank")!;
    const result = canInstall(tank.manifest, [neo.manifest]);
    expect(result.ok).toBe(true);
  });
});

// ── loadAgentFromDir integration ─────────────────────────────────────────────

describe("loadAgentFromDir", () => {
  test("loads all bundled agents without errors", async () => {
    const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
    for (const entry of entries.filter((e) => e.isDirectory())) {
      const dir = join(AGENTS_DIR, entry.name);
      const result = await loadAgentFromDir(dir);
      expect(result.errors, `${entry.name} load errors: ${result.errors.join(", ")}`).toHaveLength(
        0,
      );
      expect(result.manifest, `${entry.name} missing manifest`).toBeDefined();
    }
  });
});

// ── validateAgentMd unit tests ───────────────────────────────────────────────

describe("validateAgentMd", () => {
  test("accepts plain markdown", () => {
    const result = validateAgentMd("# Agent\n\nSome instructions.");
    expect(result.valid).toBe(true);
  });

  test("rejects YAML frontmatter", () => {
    const result = validateAgentMd("---\ntitle: Agent\n---\n# Agent");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("frontmatter");
  });
});

// ── validateManifestYaml unit tests ──────────────────────────────────────────

describe("validateManifestYaml", () => {
  test("rejects invalid YAML", () => {
    const result = validateManifestYaml("{{invalid");
    expect(result.valid).toBe(false);
  });

  test("rejects missing required fields", () => {
    const result = validateManifestYaml("id: test\nname: Test");
    expect(result.valid).toBe(false);
  });

  test("rejects tier 3 without requires", () => {
    const yaml = `
id: test
name: Test
tier: 3
role: Specialist
department: test
description: A test agent
version: 1.0.0
`;
    const result = validateManifestYaml(yaml);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("requires"))).toBe(true);
  });

  test("accepts valid minimal manifest", () => {
    const yaml = `
id: test
name: Test
tier: 2
role: Lead
department: test
description: A test agent
version: 1.0.0
`;
    const result = validateManifestYaml(yaml);
    expect(result.valid).toBe(true);
  });
});
