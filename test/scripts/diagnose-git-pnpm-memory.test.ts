import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const script = path.join(repoRoot, "scripts", "diagnose-git-pnpm-memory.mjs");

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("diagnose-git-pnpm-memory", () => {
  it("documents limits, outputs, exit codes, and examples", () => {
    const result = run(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--memory <size>");
    expect(result.stdout).toContain("--cpus <count>");
    expect(result.stdout).toContain("summary.json");
    expect(result.stdout).toContain("Exit 0");
    expect(result.stdout.match(/node scripts\/diagnose-git-pnpm-memory\.mjs/g)).toHaveLength(5);
  });

  it("prints the bounded no-retry phase plan without invoking Docker", () => {
    const result = run(["--dry-run", "--skip-install"]);
    const plan = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(plan.limits).toMatchObject({
      memory: "8g",
      memorySwap: "8g",
      pids: 1024,
      retries: 0,
      cpus: 4,
      nodeHeapMiB: 0,
    });
    expect(plan.phases).toContain("github-fetch-base");
    expect(plan.phases).toContain("github-checkout-base");
    expect(plan.phases).toContain("github-fetch-head");
    expect(plan.phases).toContain("local-unfiltered-fetch");
    expect(plan.phases).toContain("local-light-fetch");
    expect(plan.phases).not.toContain("pnpm-install");
  });

  it("rejects limits above the supported 16 GiB comparison", () => {
    const result = run(["--dry-run", "--memory", "17g"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--memory must be between 512m and 16g");
  });

  it("rejects a non-empty output directory before invoking Docker", () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "openclaw-memory-diagnostic-"));
    try {
      writeFileSync(path.join(outputDir, "previous-run"), "stale\n");
      const result = run(["--output-dir", outputDir, "--skip-install"]);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--output-dir must be empty");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
