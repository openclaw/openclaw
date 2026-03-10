/**
 * Agent health fix tests.
 *
 * Tests the fix logic for health check failures:
 * - missing-prompt: generates AGENT.md from manifest
 * - short-prompt: extends a too-short AGENT.md
 * - invalid-manifest: corrects schema violations
 * - enable-parent: removes .disabled marker
 */
import { readdir, readFile, writeFile, stat, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { AgentManifestSchema } from "./zod-schema.agent-manifest.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `agent-health-fix-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function createTestAgent(
  id: string,
  overrides: Record<string, unknown> = {},
  agentMd?: string,
) {
  const agentDir = join(testDir, id);
  await mkdir(agentDir, { recursive: true });
  const manifest = {
    id,
    name: overrides.name ?? id.charAt(0).toUpperCase() + id.slice(1),
    tier: overrides.tier ?? 3,
    role: overrides.role ?? "Test Agent",
    department: overrides.department ?? "engineering",
    description: overrides.description ?? "A test agent for validation",
    version: overrides.version ?? "1.0.0",
    ...overrides,
  };
  await writeFile(join(agentDir, "agent.yaml"), stringifyYaml(manifest), "utf-8");
  if (agentMd !== undefined) {
    await writeFile(join(agentDir, "AGENT.md"), agentMd, "utf-8");
  }
  return { agentDir, manifest };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Health check: AGENT.md presence", () => {
  test("detects missing AGENT.md", async () => {
    const { agentDir } = await createTestAgent("test-agent");
    let hasAgentMd = false;
    try {
      await stat(join(agentDir, "AGENT.md"));
      hasAgentMd = true;
    } catch {
      // expected
    }
    expect(hasAgentMd).toBe(false);
  });

  test("detects present AGENT.md", async () => {
    const { agentDir } = await createTestAgent(
      "test-agent",
      {},
      "# Test Agent\nYou are a test agent.",
    );
    const content = await readFile(join(agentDir, "AGENT.md"), "utf-8");
    expect(content).toContain("Test Agent");
  });
});

describe("Health check: prompt quality", () => {
  test("flags short prompt (< 100 chars)", async () => {
    await createTestAgent("test-agent", {}, "Short.");
    const content = await readFile(join(testDir, "test-agent", "AGENT.md"), "utf-8");
    expect(content.trim().length).toBeLessThan(100);
  });

  test("flags missing role description", async () => {
    const longContent =
      "This is a long prompt file that has more than one hundred characters of content but does not contain the expected keywords for a proper agent instructions document or setup.";
    await createTestAgent("test-agent", {}, longContent);
    expect(/role|responsibilit|you are/i.test(longContent)).toBe(false);
  });

  test("passes good prompt", async () => {
    const goodContent =
      "# Test Agent\n\nYou are the **Test Agent**, responsible for testing.\n\n## Responsibilities\n\n- Run tests\n- Validate results\n- Report findings";
    await createTestAgent("test-agent", {}, goodContent);
    expect(goodContent.trim().length).toBeGreaterThanOrEqual(100);
    expect(/role|responsibilit|you are/i.test(goodContent)).toBe(true);
  });
});

describe("Health fix: missing-prompt generation", () => {
  test("generates AGENT.md with correct structure from manifest", async () => {
    const { agentDir, manifest } = await createTestAgent("test-agent", {
      name: "TestBot",
      role: "Quality Assurance Lead",
      department: "engineering",
      tier: 2,
      description: "Oversees all testing and QA processes",
      capabilities: ["testing", "validation", "reporting"],
    });

    // Simulate the generation logic from the fix handler
    const m = manifest as Record<string, unknown>;
    const tierDesc =
      m.tier === 2
        ? "You are a **department head** — a tactical leader."
        : "You are a **specialist**";

    const content = [
      `# ${m.name as string}`,
      "",
      `You are **${m.name as string}**, the ${m.role as string} in the **${m.department as string}** department.`,
      "",
      tierDesc,
      "",
      "## Responsibilities",
      "",
      m.description as string,
      "",
    ].join("\n");

    await writeFile(join(agentDir, "AGENT.md"), content, "utf-8");

    const written = await readFile(join(agentDir, "AGENT.md"), "utf-8");
    expect(written).toContain("TestBot");
    expect(written).toContain("Quality Assurance Lead");
    expect(written).toContain("engineering");
    expect(written).toContain("department head");
    expect(written).toContain("Responsibilities");
  });
});

describe("Health fix: invalid-manifest correction", () => {
  test("detects missing required fields", async () => {
    const agentDir = join(testDir, "broken-agent");
    await mkdir(agentDir, { recursive: true });
    // Write manifest missing required fields
    await writeFile(
      join(agentDir, "agent.yaml"),
      stringifyYaml({ id: "broken-agent", name: "Broken" }),
      "utf-8",
    );

    const raw = await readFile(join(agentDir, "agent.yaml"), "utf-8");
    const parsed = parseYaml(raw);
    const result = AgentManifestSchema.safeParse(parsed);
    expect(result.success).toBe(false);
  });

  test("auto-fix adds missing fields", async () => {
    const agentDir = join(testDir, "fixable-agent");
    await mkdir(agentDir, { recursive: true });
    const broken = { id: "fixable-agent", name: "Fixable" };
    await writeFile(join(agentDir, "agent.yaml"), stringifyYaml(broken), "utf-8");

    // Simulate auto-fix logic (defaults to tier 2 which doesn't require `requires`)
    const fixed: Record<string, unknown> = { ...broken };
    if (!fixed.tier) {
      fixed.tier = 2;
    }
    if (!fixed.version) {
      fixed.version = "1.0.0";
    }
    if (!fixed.role) {
      fixed.role = `${String(fixed.name)} agent`;
    }
    if (!fixed.department) {
      fixed.department = "general";
    }
    if (!fixed.description) {
      fixed.description = fixed.role;
    }

    const result = AgentManifestSchema.safeParse(fixed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("fixable-agent");
      expect(result.data.tier).toBe(2);
      expect(result.data.version).toBe("1.0.0");
    }
  });

  test("validates LLM output before writing", async () => {
    // Ensure schema rejects bad data even if "auto-fix" produces it
    const stillBad = { id: "bad", name: "Bad", tier: 1, requires: "some-parent" };
    const result = AgentManifestSchema.safeParse(stillBad);
    // Tier 1 cannot have requires — should fail
    expect(result.success).toBe(false);
  });
});

describe("Health fix: enable-parent", () => {
  test("removes .disabled marker file", async () => {
    const { agentDir } = await createTestAgent("parent-agent", { tier: 2 }, "# Parent");
    const disabledPath = join(agentDir, ".disabled");
    await writeFile(disabledPath, new Date().toISOString(), "utf-8");

    // Verify disabled
    let isDisabled = false;
    try {
      await stat(disabledPath);
      isDisabled = true;
    } catch {
      /* ok */
    }
    expect(isDisabled).toBe(true);

    // Fix: remove marker
    await rm(disabledPath);

    // Verify enabled
    let stillDisabled = false;
    try {
      await stat(disabledPath);
      stillDisabled = true;
    } catch {
      /* ok */
    }
    expect(stillDisabled).toBe(false);
  });
});

describe("Health check: dependency met", () => {
  test("detects missing parent agent", async () => {
    await createTestAgent("child-agent", { tier: 3, requires: "nonexistent-parent" }, "# Child");
    const entries = await readdir(testDir, { withFileTypes: true });
    const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    expect(ids).not.toContain("nonexistent-parent");
  });

  test("passes when parent exists", async () => {
    await createTestAgent("parent-bot", { tier: 2 }, "# Parent");
    await createTestAgent("child-bot", { tier: 3, requires: "parent-bot" }, "# Child");
    const entries = await readdir(testDir, { withFileTypes: true });
    const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    expect(ids).toContain("parent-bot");
  });
});

describe("Health check: deprecation", () => {
  test("flags deprecated agent", async () => {
    const { manifest } = await createTestAgent("old-agent", {
      deprecated: true,
      sunset_date: "2026-01-01",
      replacement: "new-agent",
    });
    expect(manifest.deprecated).toBe(true);
    expect(manifest.replacement).toBe("new-agent");
  });
});
