import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  addAllowlistEntry,
  ensureExecApprovals,
  loadExecApprovals,
  resolveExecApprovals,
  resolveExecApprovalsPath,
} from "./exec-approvals.js";

describe("exec-approvals persistence", () => {
  let testConfigPath: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-approvals-test-"));
    testConfigPath = path.join(tmpDir, "exec-approvals.json");
    originalEnv = process.env.OPENCLAW_EXEC_APPROVALS_FILE;
    process.env.OPENCLAW_EXEC_APPROVALS_FILE = testConfigPath;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OPENCLAW_EXEC_APPROVALS_FILE = originalEnv;
    } else {
      delete process.env.OPENCLAW_EXEC_APPROVALS_FILE;
    }
    const dir = path.dirname(testConfigPath);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves allowlist entries across ensureExecApprovals calls", () => {
    // Initial call creates the file
    const initial = ensureExecApprovals();
    expect(initial.agents).toEqual({});

    // Add an allowlist entry
    addAllowlistEntry(initial, "test-agent", "ls");

    // Load the file and verify the entry was saved
    const loaded = loadExecApprovals();
    expect(loaded.agents?.["test-agent"]?.allowlist).toHaveLength(1);
    expect(loaded.agents?.["test-agent"]?.allowlist?.[0].pattern).toBe("ls");

    // Call ensureExecApprovals again (simulates next exec call)
    const ensured = ensureExecApprovals();

    // The allowlist entry should still be present
    expect(ensured.agents?.["test-agent"]?.allowlist).toHaveLength(1);
    expect(ensured.agents?.["test-agent"]?.allowlist?.[0].pattern).toBe("ls");
  });

  it("preserves defaults field across ensureExecApprovals calls", () => {
    // Write a file with explicit defaults (simulating a file after allow-always was used)
    const fileWithDefaults = {
      version: 1 as const,
      socket: {
        path: resolveExecApprovalsPath().replace("exec-approvals.json", "exec-approvals.sock"),
        token: "test-token",
      },
      defaults: {
        security: "allowlist" as const,
        ask: "on-miss" as const,
        askFallback: "deny" as const,
        autoAllowSkills: true,
      },
      agents: {},
    };
    fs.writeFileSync(testConfigPath, JSON.stringify(fileWithDefaults, null, 2));

    // Call ensureExecApprovals (should preserve defaults)
    const ensured = ensureExecApprovals();

    // Defaults should be preserved
    expect(ensured.defaults).toEqual({
      security: "allowlist",
      ask: "on-miss",
      askFallback: "deny",
      autoAllowSkills: true,
    });
  });

  it("preserves allowlist entries when defaults is empty object", () => {
    // Create initial file with empty defaults (the bug scenario)
    const initial = ensureExecApprovals();
    initial.defaults = {} as unknown as typeof initial.defaults;
    initial.agents = {}; // Ensure no existing entries
    fs.writeFileSync(testConfigPath, JSON.stringify(initial, null, 2));

    // Verify initial state (use unique agent name to avoid cross-test pollution)
    const beforeAdd = loadExecApprovals();
    const uniqueAgent = "test-agent-empty-defaults";
    expect(beforeAdd.agents?.[uniqueAgent]?.allowlist).toBeUndefined();

    // Add an allowlist entry
    const loaded = loadExecApprovals();
    addAllowlistEntry(loaded, uniqueAgent, "openclaw status");

    // Verify the entry was saved (should be exactly 1)
    const afterAdd = loadExecApprovals();
    const agentAllowlist = afterAdd.agents?.[uniqueAgent]?.allowlist;
    expect(agentAllowlist).toBeDefined();
    expect(agentAllowlist).toHaveLength(1);
    expect(agentAllowlist?.[0].pattern).toBe("openclaw status");

    // Call ensureExecApprovals multiple times (simulates multiple exec calls)
    // This should NOT add duplicate entries
    ensureExecApprovals();
    ensureExecApprovals();
    const final = ensureExecApprovals();

    // The allowlist entry should still be present (exactly 1, not duplicated)
    const finalAllowlist = final.agents?.[uniqueAgent]?.allowlist;
    expect(finalAllowlist).toBeDefined();
    expect(finalAllowlist).toHaveLength(1);
    expect(finalAllowlist?.[0].pattern).toBe("openclaw status");
  });

  it("resolveExecApprovals preserves file defaults for subsequent saves", () => {
    // Create initial file with an allowlist entry
    const initial = ensureExecApprovals();
    addAllowlistEntry(initial, "agent-1", "git status");

    // Resolve approvals (this calls normalizeExecApprovals internally)
    const resolved = resolveExecApprovals("agent-1");

    // The file object should still have the allowlist entry
    expect(resolved.file.agents?.["agent-1"]?.allowlist).toHaveLength(1);
    expect(resolved.file.agents?.["agent-1"]?.allowlist?.[0].pattern).toBe("git status");

    // Save the file object (simulates addAllowlistEntry workflow)
    fs.writeFileSync(testConfigPath, JSON.stringify(resolved.file, null, 2));

    // Load and verify
    const reloaded = loadExecApprovals();
    expect(reloaded.agents?.["agent-1"]?.allowlist).toHaveLength(1);
  });
});
