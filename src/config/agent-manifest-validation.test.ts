/**
 * Agent marketplace manifest validation tests.
 *
 * Validates all bundled agents against the AgentManifestSchema, checks
 * AGENT.md format, and verifies tier dependency chains.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test, expect } from "vitest";
import {
  validateAgentMd,
  validateManifestYaml,
  validateTierDependencies,
  findDependents,
  canInstall,
  loadAgentFromDir,
  hasAgentMdFrontmatter,
  parseUnifiedAgentMd,
} from "./agent-manifest-validation.js";
import { AgentManifestSchema, type AgentManifest } from "./zod-schema.agent-manifest.js";

// ── Bundled agents directory ─────────────────────────────────────────────────

const AGENTS_DIR = join(import.meta.dirname, "..", "..", "agents");
/** Directories that are not agent folders. */
const EXCLUDED_DIRS = new Set(["personas", "_archive"]);

function isAgentDir(name: string): boolean {
  return !EXCLUDED_DIRS.has(name) && !name.startsWith(".");
}

async function loadAllBundledAgents(): Promise<
  { id: string; manifest: AgentManifest; dir: string }[]
> {
  const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
  const agents: { id: string; manifest: AgentManifest; dir: string }[] = [];
  for (const entry of entries.filter((e) => e.isDirectory() && isAgentDir(e.name))) {
    const dir = join(AGENTS_DIR, entry.name);
    const result = await loadAgentFromDir(dir);
    if (result.manifest) {
      agents.push({ id: result.manifest.id, manifest: result.manifest, dir });
    }
  }
  return agents;
}

// ── Schema validation tests ──────────────────────────────────────────────────

describe("Bundled agent schema validation", () => {
  test("all bundled agents pass schema validation (unified or legacy)", async () => {
    const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && isAgentDir(e.name));

    for (const entry of dirs) {
      const dir = join(AGENTS_DIR, entry.name);
      const result = await loadAgentFromDir(dir);
      expect(result.errors, `${entry.name} errors: ${result.errors.join(", ")}`).toHaveLength(0);
      expect(result.manifest, `${entry.name} missing manifest`).toBeDefined();
    }

    // Count agents vs bundles separately for clarity
    const agents = await loadAllBundledAgents();
    const agentCount = agents.filter((a) => !a.manifest.is_bundle).length;
    // 4 core agents (operator1, neo, morpheus, trinity) in unified format
    expect(agentCount).toBeGreaterThanOrEqual(4);
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
  test("all non-bundle agents have AGENT.md files", async () => {
    const agents = await loadAllBundledAgents();
    for (const { id, manifest, dir } of agents) {
      if (manifest.is_bundle) {
        continue;
      }
      const mdPath = join(dir, "AGENT.md");
      const content = await readFile(mdPath, "utf-8");
      expect(content.length, `${id}/AGENT.md is empty`).toBeGreaterThan(0);
    }
  });

  test("all agents load with consistent format (unified or legacy)", async () => {
    const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
    for (const entry of entries.filter((e) => e.isDirectory() && isAgentDir(e.name))) {
      const dir = join(AGENTS_DIR, entry.name);
      const result = await loadAgentFromDir(dir);
      expect(result.errors, `${entry.name}: ${result.errors.join(", ")}`).toHaveLength(0);
      expect(result.manifest).toBeDefined();
      // unified field should be set
      expect(typeof result.unified).toBe("boolean");
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

  test("all core agents have persona field set", async () => {
    const agents = await loadAllBundledAgents();
    const expectedPersonas: Record<string, string> = {
      operator1: "coo",
      neo: "cto",
      morpheus: "cmo",
      trinity: "cfo",
    };
    for (const [id, expectedPersona] of Object.entries(expectedPersonas)) {
      const agent = agents.find((a) => a.id === id);
      expect(agent, `${id} not found`).toBeDefined();
      expect(agent!.manifest.persona, `${id} should have persona=${expectedPersona}`).toBe(
        expectedPersona,
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
  test("core agents have no dependents (specialists archived)", async () => {
    const agents = await loadAllBundledAgents();
    const manifests = agents.map((a) => a.manifest);
    for (const agent of agents) {
      const deps = findDependents(agent.id, manifests);
      // With only 4 core agents active, no tier 3 agents exist
      expect(deps).toHaveLength(0);
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

  test("tier 1 agent (operator1) can install independently", async () => {
    const agents = await loadAllBundledAgents();
    const op1 = agents.find((a) => a.id === "operator1")!;
    const result = canInstall(op1.manifest, []);
    expect(result.ok).toBe(true);
  });
});

// ── loadAgentFromDir integration ─────────────────────────────────────────────

describe("loadAgentFromDir", () => {
  test("loads all bundled agents without errors", async () => {
    const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
    for (const entry of entries.filter((e) => e.isDirectory() && isAgentDir(e.name))) {
      const dir = join(AGENTS_DIR, entry.name);
      const result = await loadAgentFromDir(dir);
      expect(result.errors, `${entry.name} load errors: ${result.errors.join(", ")}`).toHaveLength(
        0,
      );
      expect(result.manifest, `${entry.name} missing manifest`).toBeDefined();
    }
  });
});

// ── validateAgentMd (legacy) unit tests ──────────────────────────────────────

describe("validateAgentMd (legacy)", () => {
  test("accepts plain markdown", () => {
    const result = validateAgentMd("# Agent\n\nSome instructions.");
    expect(result.valid).toBe(true);
  });

  test("rejects YAML frontmatter in legacy mode", () => {
    const result = validateAgentMd("---\ntitle: Agent\n---\n# Agent");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("frontmatter");
  });
});

// ── Unified AGENT.md format tests ───────────────────────────────────────────

describe("hasAgentMdFrontmatter", () => {
  test("detects frontmatter", () => {
    expect(hasAgentMdFrontmatter("---\nid: test\n---\n# Agent")).toBe(true);
  });

  test("rejects plain markdown", () => {
    expect(hasAgentMdFrontmatter("# Agent\n\nSome instructions.")).toBe(false);
  });

  test("rejects empty content", () => {
    expect(hasAgentMdFrontmatter("")).toBe(false);
  });
});

describe("parseUnifiedAgentMd", () => {
  test("parses valid unified AGENT.md", () => {
    const content = `---
id: test-agent
name: Test Agent
tier: 2
role: Tester
department: testing
description: A test agent
version: 1.0.0
persona: security-engineer
---

# Test Agent

You are a test agent.

## Responsibilities

- Run tests
`;
    const result = parseUnifiedAgentMd(content);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.frontmatter.id).toBe("test-agent");
      expect(result.frontmatter.name).toBe("Test Agent");
      expect(result.frontmatter.persona).toBe("security-engineer");
      expect(result.body).toContain("# Test Agent");
      expect(result.body).toContain("## Responsibilities");
    }
  });

  test("returns error for missing closing delimiter", () => {
    const content = "---\nid: test\nno closing delimiter";
    const result = parseUnifiedAgentMd(content);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("closing ---");
    }
  });

  test("returns error for invalid YAML in frontmatter", () => {
    const content = "---\n{{invalid yaml\n---\n# Agent";
    const result = parseUnifiedAgentMd(content);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Invalid YAML");
    }
  });

  test("validates frontmatter against AgentManifestSchema", () => {
    const content = `---
id: valid-agent
name: Valid
tier: 2
role: Lead
department: eng
description: Valid agent
version: 1.0.0
---

# Valid Agent
`;
    const parsed = parseUnifiedAgentMd(content);
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      const result = AgentManifestSchema.safeParse(parsed.frontmatter);
      expect(result.success).toBe(true);
    }
  });

  test("persona field is optional and validated", () => {
    const content = `---
id: persona-agent
name: Persona Agent
tier: 2
role: Lead
department: eng
description: Agent with persona
version: 1.0.0
persona: cto
---

# Agent
`;
    const parsed = parseUnifiedAgentMd(content);
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      const result = AgentManifestSchema.safeParse(parsed.frontmatter);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.persona).toBe("cto");
      }
    }
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
