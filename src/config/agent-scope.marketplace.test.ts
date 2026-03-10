/**
 * Marketplace agent scope & lock file tests.
 *
 * Tests the installation scope system (local/project/user),
 * lock file CRUD operations, and cross-scope resolution.
 */
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import {
  agentsDirForScope,
  lockFileForScope,
  resolveAllAgents,
  readLockFile,
  writeLockFile,
  addToLockFile,
  removeFromLockFile,
  type AgentScope,
} from "./agent-scope.js";
import type { AgentsLock } from "./zod-schema.agent-manifest.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

let testDir: string;

async function writeAgentYaml(
  scope: AgentScope,
  agentId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const dir = join(agentsDirForScope(scope, testDir), agentId);
  await mkdir(dir, { recursive: true });
  const yaml = stringifyYaml({
    id: agentId,
    name: agentId.charAt(0).toUpperCase() + agentId.slice(1),
    tier: 2,
    role: "Test",
    department: "test",
    description: `Test agent ${agentId}`,
    version: "1.0.0",
    ...overrides,
  });
  await writeFile(join(dir, "agent.yaml"), yaml);
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "agent-scope-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ── Scope path tests ─────────────────────────────────────────────────────────

describe("agentsDirForScope", () => {
  test("returns correct paths for each scope", () => {
    expect(agentsDirForScope("local", "/project")).toBe("/project/.openclaw/agents.local");
    expect(agentsDirForScope("project", "/project")).toBe("/project/.openclaw/agents");
    // user scope uses homedir — just check it's a string
    expect(typeof agentsDirForScope("user", "/project")).toBe("string");
  });
});

describe("lockFileForScope", () => {
  test("returns correct paths for each scope", () => {
    expect(lockFileForScope("local", "/project")).toBe("/project/.openclaw/agents.local-lock.yaml");
    expect(lockFileForScope("project", "/project")).toBe("/project/.openclaw/agents-lock.yaml");
  });
});

// ── Lock file CRUD tests ────────────────────────────────────────────────────

describe("Lock file operations", () => {
  test("readLockFile returns null for non-existent file", async () => {
    const result = await readLockFile("project", testDir);
    expect(result).toBeNull();
  });

  test("writeLockFile creates and readLockFile reads back", async () => {
    const lock: AgentsLock = {
      lockfile_version: 1,
      agents: {
        neo: {
          version: "1.0.0",
          installed_at: new Date().toISOString(),
          scope: "project",
        },
      },
    };
    await writeLockFile("project", testDir, lock);
    const result = await readLockFile("project", testDir);
    expect(result).not.toBeNull();
    expect(result!.lockfile_version).toBe(1);
    expect(result!.agents?.neo?.version).toBe("1.0.0");
  });

  test("addToLockFile adds entry to new lock file", async () => {
    await addToLockFile("project", testDir, "neo", {
      version: "1.0.0",
    });
    const lock = await readLockFile("project", testDir);
    expect(lock).not.toBeNull();
    expect(lock!.agents?.neo).toBeDefined();
    expect(lock!.agents!.neo.version).toBe("1.0.0");
    expect(lock!.agents!.neo.scope).toBe("project");
    expect(lock!.agents!.neo.installed_at).toBeTruthy();
  });

  test("addToLockFile appends to existing lock file", async () => {
    await addToLockFile("project", testDir, "neo", { version: "1.0.0" });
    await addToLockFile("project", testDir, "tank", {
      version: "1.0.0",
      requires: "neo@1.0.0",
    });
    const lock = await readLockFile("project", testDir);
    expect(Object.keys(lock!.agents!)).toHaveLength(2);
    expect(lock!.agents!.tank.requires).toBe("neo@1.0.0");
  });

  test("removeFromLockFile removes entry", async () => {
    await addToLockFile("project", testDir, "neo", { version: "1.0.0" });
    await addToLockFile("project", testDir, "tank", { version: "1.0.0" });
    await removeFromLockFile("project", testDir, "tank");
    const lock = await readLockFile("project", testDir);
    expect(lock!.agents!.neo).toBeDefined();
    expect(lock!.agents!.tank).toBeUndefined();
  });

  test("removeFromLockFile is a no-op for non-existent entry", async () => {
    await addToLockFile("project", testDir, "neo", { version: "1.0.0" });
    await removeFromLockFile("project", testDir, "nonexistent");
    const lock = await readLockFile("project", testDir);
    expect(lock!.agents!.neo).toBeDefined();
  });

  test("removeFromLockFile is a no-op when no lock file exists", async () => {
    // Should not throw
    await removeFromLockFile("project", testDir, "neo");
  });

  test("lock files are independent per scope", async () => {
    await addToLockFile("project", testDir, "neo", { version: "1.0.0" });
    await addToLockFile("local", testDir, "custom-agent", { version: "2.0.0" });

    const projectLock = await readLockFile("project", testDir);
    const localLock = await readLockFile("local", testDir);

    expect(projectLock!.agents!.neo).toBeDefined();
    expect(projectLock!.agents!["custom-agent"]).toBeUndefined();
    expect(localLock!.agents!["custom-agent"]).toBeDefined();
    expect(localLock!.agents!.neo).toBeUndefined();
  });
});

// ── Scope resolution tests ───────────────────────────────────────────────────

describe("resolveAllAgents", () => {
  test("loads agents from project scope", async () => {
    await writeAgentYaml("project", "neo");
    await writeAgentYaml("project", "trinity");

    const agents = await resolveAllAgents(testDir);
    const ids = agents.map((a) => a.manifest.id).toSorted();
    expect(ids).toEqual(["neo", "trinity"]);
    expect(agents.every((a) => a.scope === "project")).toBe(true);
  });

  test("local scope overrides project scope on ID collision", async () => {
    await writeAgentYaml("project", "neo", { description: "Project Neo" });
    await writeAgentYaml("local", "neo", { description: "Local Neo" });

    const agents = await resolveAllAgents(testDir);
    const neo = agents.find((a) => a.manifest.id === "neo");
    expect(neo).toBeDefined();
    expect(neo!.scope).toBe("local");
    expect(neo!.manifest.description).toBe("Local Neo");
  });

  test("merges agents from multiple scopes", async () => {
    await writeAgentYaml("project", "neo");
    await writeAgentYaml("local", "custom");

    const agents = await resolveAllAgents(testDir);
    expect(agents).toHaveLength(2);
    const neo = agents.find((a) => a.manifest.id === "neo");
    const custom = agents.find((a) => a.manifest.id === "custom");
    expect(neo!.scope).toBe("project");
    expect(custom!.scope).toBe("local");
  });

  test("returns empty array when no scope directories exist", async () => {
    const agents = await resolveAllAgents(testDir);
    expect(agents).toHaveLength(0);
  });

  test("skips invalid agent directories", async () => {
    await writeAgentYaml("project", "neo");
    // Create a dir with invalid yaml
    const badDir = join(agentsDirForScope("project", testDir), "broken");
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "agent.yaml"), "{{invalid yaml");

    const agents = await resolveAllAgents(testDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].manifest.id).toBe("neo");
  });
});
