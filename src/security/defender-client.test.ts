import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isKillSwitchActive,
  resolveDefenderWorkspace,
  runDefenderAudit,
  runDefenderRuntimeMonitor,
} from "./defender-client.js";

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
  vi.unstubAllEnvs();
});

describe("resolveDefenderWorkspace", () => {
  it("returns override when provided and non-empty", () => {
    expect(resolveDefenderWorkspace("/custom/workspace")).toBe("/custom/workspace");
    expect(resolveDefenderWorkspace("  /other  ")).toBe("/other");
  });

  it("returns OPENCLAW_WORKSPACE when set and no override", () => {
    vi.stubEnv("OPENCLAW_WORKSPACE", "/env/workspace");
    expect(resolveDefenderWorkspace()).toBe("/env/workspace");
  });

  it("falls back to ~/.openclaw/workspace when no override and no env", () => {
    vi.stubEnv("OPENCLAW_WORKSPACE", "");
    const got = resolveDefenderWorkspace();
    expect(got).toBe(path.join(os.homedir(), ".openclaw", "workspace"));
  });

  it("ignores empty override and uses env or default", () => {
    vi.stubEnv("OPENCLAW_WORKSPACE", "/env/workspace");
    expect(resolveDefenderWorkspace("")).toBe("/env/workspace");
    expect(resolveDefenderWorkspace("   ")).toBe("/env/workspace");
  });
});

describe("isKillSwitchActive", () => {
  it("returns false when .kill-switch does not exist", async () => {
    const workspaceDir = makeTmpDir("defender-client");
    await fs.mkdir(workspaceDir, { recursive: true });
    const active = await isKillSwitchActive(workspaceDir);
    expect(active).toBe(false);
  });

  it("returns true when .kill-switch exists", async () => {
    const workspaceDir = makeTmpDir("defender-client");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, ".kill-switch"), "ACTIVATED\n", "utf-8");
    const active = await isKillSwitchActive(workspaceDir);
    expect(active).toBe(true);
  });
});

describe("runDefenderRuntimeMonitor", () => {
  it("returns ok: true when script is not present (skip check)", async () => {
    const workspaceDir = makeTmpDir("defender-client");
    await fs.mkdir(workspaceDir, { recursive: true });
    const result = await runDefenderRuntimeMonitor(workspaceDir, "kill-switch", ["check"], 5_000);
    expect(result.ok).toBe(true);
    expect(result.stderr).toBeUndefined();
  });

  it("returns ok: true when script exists and check passes", async () => {
    const workspaceDir = makeTmpDir("defender-client");
    await fs.mkdir(path.join(workspaceDir, "skills", "openclaw-defender", "scripts"), {
      recursive: true,
    });
    const scriptPath = path.join(
      workspaceDir,
      "skills",
      "openclaw-defender",
      "scripts",
      "runtime-monitor.sh",
    );
    await fs.writeFile(
      scriptPath,
      '#!/bin/bash\ncase "$1" in kill-switch) [ "$2" != check ] || exit 0;; *) exit 0;; esac\n',
      "utf-8",
    );
    await fs.chmod(scriptPath, 0o755);
    const result = await runDefenderRuntimeMonitor(workspaceDir, "kill-switch", ["check"], 5_000);
    expect(result.ok).toBe(true);
  });

  it("returns ok: false with stderr when script exits non-zero", async () => {
    const workspaceDir = makeTmpDir("defender-client");
    await fs.mkdir(path.join(workspaceDir, "skills", "openclaw-defender", "scripts"), {
      recursive: true,
    });
    const scriptPath = path.join(
      workspaceDir,
      "skills",
      "openclaw-defender",
      "scripts",
      "runtime-monitor.sh",
    );
    await fs.writeFile(
      scriptPath,
      '#!/bin/bash\necho "Command blocked by policy" >&2\nexit 1\n',
      "utf-8",
    );
    await fs.chmod(scriptPath, 0o755);
    const result = await runDefenderRuntimeMonitor(
      workspaceDir,
      "check-command",
      ["rm -rf /", "test-skill"],
      5_000,
    );
    expect(result.ok).toBe(false);
    expect(result.stderr).toBeDefined();
    expect(result.stderr).toContain("Command blocked by policy");
  });

  it("returns ok: false when script times out", async () => {
    const workspaceDir = makeTmpDir("defender-client");
    await fs.mkdir(path.join(workspaceDir, "skills", "openclaw-defender", "scripts"), {
      recursive: true,
    });
    const scriptPath = path.join(
      workspaceDir,
      "skills",
      "openclaw-defender",
      "scripts",
      "runtime-monitor.sh",
    );
    await fs.writeFile(scriptPath, "#!/bin/bash\nsleep 10\nexit 0\n", "utf-8");
    await fs.chmod(scriptPath, 0o755);
    const result = await runDefenderRuntimeMonitor(workspaceDir, "test", ["arg"], 500);
    expect(result.ok).toBe(false);
    expect(result.stderr).toBeDefined();
  }, 10_000);
});

describe("runDefenderAudit", () => {
  it("returns ok: true when audit script is not present (skip gate)", async () => {
    const workspaceDir = makeTmpDir("defender-client");
    const skillDir = makeTmpDir("defender-skill");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(skillDir, { recursive: true });
    const result = await runDefenderAudit(workspaceDir, skillDir, 5_000);
    expect(result.ok).toBe(true);
    expect(result.stderr).toBeUndefined();
  });

  it("returns ok: true when audit script exists and passes", async () => {
    const workspaceDir = makeTmpDir("defender-client");
    const skillDir = makeTmpDir("defender-skill");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "skills", "openclaw-defender", "scripts"), {
      recursive: true,
    });
    await fs.mkdir(skillDir, { recursive: true });
    const scriptPath = path.join(
      workspaceDir,
      "skills",
      "openclaw-defender",
      "scripts",
      "audit-skills.sh",
    );
    await fs.writeFile(scriptPath, '#!/bin/bash\necho "Audit passed"\nexit 0\n', "utf-8");
    await fs.chmod(scriptPath, 0o755);
    const result = await runDefenderAudit(workspaceDir, skillDir, 5_000);
    expect(result.ok).toBe(true);
  });

  it("returns ok: false when audit detects violations", async () => {
    const workspaceDir = makeTmpDir("defender-client");
    const skillDir = makeTmpDir("defender-skill");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "skills", "openclaw-defender", "scripts"), {
      recursive: true,
    });
    await fs.mkdir(skillDir, { recursive: true });
    const scriptPath = path.join(
      workspaceDir,
      "skills",
      "openclaw-defender",
      "scripts",
      "audit-skills.sh",
    );
    await fs.writeFile(
      scriptPath,
      '#!/bin/bash\necho "FAIL: Malicious pattern detected" >&2\nexit 1\n',
      "utf-8",
    );
    await fs.chmod(scriptPath, 0o755);
    const result = await runDefenderAudit(workspaceDir, skillDir, 5_000);
    expect(result.ok).toBe(false);
    expect(result.stderr).toBeDefined();
    expect(result.stderr).toContain("Malicious pattern detected");
  });

  it("returns ok: false when audit times out", async () => {
    const workspaceDir = makeTmpDir("defender-client");
    const skillDir = makeTmpDir("defender-skill");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "skills", "openclaw-defender", "scripts"), {
      recursive: true,
    });
    await fs.mkdir(skillDir, { recursive: true });
    const scriptPath = path.join(
      workspaceDir,
      "skills",
      "openclaw-defender",
      "scripts",
      "audit-skills.sh",
    );
    await fs.writeFile(scriptPath, "#!/bin/bash\nsleep 10\nexit 0\n", "utf-8");
    await fs.chmod(scriptPath, 0o755);
    const result = await runDefenderAudit(workspaceDir, skillDir, 500);
    expect(result.ok).toBe(false);
    expect(result.stderr).toBeDefined();
  }, 10_000);
});
