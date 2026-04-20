import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeLeanWorkspace, handleLeanCommand } from "./commands-lean.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lean-"));
  tempDirs.push(dir);
  return dir;
}

async function writeWorkspaceFile(
  workspaceDir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("analyzeLeanWorkspace", () => {
  it("finds budget pressure, doctrine overlap, conflicts, drift, learning pressure, and concrete proposals", async () => {
    const workspaceDir = await makeWorkspace();
    const repeated = "Private things stay private, and group chats do not get personal spillover.";
    await writeWorkspaceFile(
      workspaceDir,
      "AGENTS.md",
      `# AGENTS\n\n${"A".repeat(20_600)}\n\n${repeated}\n- Send directly without asking when the message is clearly ready.\n- Try to be helpful whenever possible.\n`,
    );
    await writeWorkspaceFile(
      workspaceDir,
      "SOUL.md",
      `# SOUL\n\nGreat question, let us delve into this carefully.\nTry to stay calm whenever possible.\nPlease note that maybe the shortest path is best.\n\n${repeated}\n- Ask first before any external send.\n- The gateway on 192.168.1.8 is the reliable local target.\n`,
    );
    await writeWorkspaceFile(workspaceDir, "IDENTITY.md", "# IDENTITY\n\n- Name: Shoar\n");
    await writeWorkspaceFile(workspaceDir, "TOOLS.md", "# TOOLS\n");
    await writeWorkspaceFile(workspaceDir, "USER.md", "# USER\n");
    await writeWorkspaceFile(workspaceDir, "BOOTSTRAP.md", "# BOOTSTRAP\nStill here\n");
    await writeWorkspaceFile(
      workspaceDir,
      "PATCHES.md",
      "# PATCHES\n- Lesson: never again let the gateway fix live only in patch notes.\n- Root cause: same issue repeated because the rule was never promoted.\n",
    );
    for (let day = 1; day <= 5; day += 1) {
      await writeWorkspaceFile(
        workspaceDir,
        `memory/2026-04-0${day}.md`,
        `# Day ${day}\nA durable lesson from the day.\nShoar values direct answers over hedging.\n`,
      );
    }

    const report = await analyzeLeanWorkspace({ workspaceDir, cfg: {} });
    const kinds = new Set(report.findings.map((finding) => finding.kind));

    expect(kinds.has("bootstrap-budget")).toBe(true);
    expect(kinds.has("stale-bootstrap")).toBe(true);
    expect(kinds.has("mushy-rule")).toBe(true);
    expect(kinds.has("duplicate-doctrine")).toBe(true);
    expect(kinds.has("doctrine-conflict")).toBe(true);
    expect(kinds.has("memory-placement")).toBe(true);
    expect(kinds.has("drift-signal")).toBe(true);
    expect(kinds.has("learning-pressure") || kinds.has("patch-pressure")).toBe(true);
    expect(report.proposals.some((proposal) => proposal.action === "merge")).toBe(true);
    expect(report.proposals.some((proposal) => proposal.action === "relocate")).toBe(true);
    expect(report.scorecard.overall).toBeLessThan(100);
  });

  it("applies formatting-safe cleanup, semantic-safe cleanup, and reports both", async () => {
    const workspaceDir = await makeWorkspace();
    await writeWorkspaceFile(
      workspaceDir,
      "AGENTS.md",
      "# AGENTS  \n\n\n\nRule with trailing spaces   \nRule with trailing spaces\n",
    );
    await writeWorkspaceFile(workspaceDir, "SOUL.md", "# SOUL\n");
    await writeWorkspaceFile(workspaceDir, "IDENTITY.md", "# IDENTITY\n");
    await writeWorkspaceFile(workspaceDir, "TOOLS.md", "# TOOLS\n");
    await writeWorkspaceFile(workspaceDir, "BOOTSTRAP.md", "# BOOTSTRAP\nStill here\n");

    const report = await analyzeLeanWorkspace({ workspaceDir, cfg: {}, applySafeFixes: true });
    const agents = await fs.readFile(path.join(workspaceDir, "AGENTS.md"), "utf8");

    expect(report.safeFixesApplied.some((entry) => entry.path === "AGENTS.md")).toBe(true);
    expect(report.semanticFixesApplied.some((entry) => entry.path === "AGENTS.md")).toBe(true);
    expect(report.semanticFixesApplied.some((entry) => entry.path === "BOOTSTRAP.md")).toBe(true);
    expect(
      await fs
        .access(path.join(workspaceDir, "BOOTSTRAP.md"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    expect(agents).toBe("# AGENTS\n\nRule with trailing spaces\n");
  });
});

describe("handleLeanCommand", () => {
  it("runs the full flow by default and returns premium actionable output", async () => {
    const workspaceDir = await makeWorkspace();
    await writeWorkspaceFile(
      workspaceDir,
      "AGENTS.md",
      "# AGENTS  \n\n\nRule with trailing spaces   \nRule with trailing spaces\n",
    );
    await writeWorkspaceFile(
      workspaceDir,
      "SOUL.md",
      "# SOUL\n- Ask first before any external send.\n- The gateway on 192.168.1.8 is the reliable local target.\nTry to stay calm whenever possible.\n",
    );
    await writeWorkspaceFile(workspaceDir, "IDENTITY.md", "# IDENTITY\n");
    await writeWorkspaceFile(workspaceDir, "TOOLS.md", "# TOOLS\n");
    await writeWorkspaceFile(workspaceDir, "BOOTSTRAP.md", "# BOOTSTRAP\nStill here\n");

    const params = buildCommandTestParams("/lean", {}, undefined, { workspaceDir });
    const result = await handleLeanCommand(params, true);
    const agents = await fs.readFile(path.join(workspaceDir, "AGENTS.md"), "utf8");

    expect(result?.reply?.text).toContain("🪶 Lean");
    expect(result?.reply?.text).toContain("Scorecard:");
    expect(result?.reply?.text).toContain("Upgrade moves:");
    expect(result?.reply?.text).toContain("Auto-applied now, formatting:");
    expect(result?.reply?.text).toContain("Auto-applied now, semantic-safe:");
    expect(agents).toBe("# AGENTS\n\nRule with trailing spaces\n");
  });

  it("ignores legacy suffixes and still runs the single-command flow", async () => {
    const workspaceDir = await makeWorkspace();
    await writeWorkspaceFile(workspaceDir, "AGENTS.md", "# AGENTS\n");
    await writeWorkspaceFile(workspaceDir, "SOUL.md", "# SOUL\n");
    await writeWorkspaceFile(workspaceDir, "IDENTITY.md", "# IDENTITY\n");
    await writeWorkspaceFile(workspaceDir, "TOOLS.md", "# TOOLS\n");

    const params = buildCommandTestParams("/lean help", {}, undefined, { workspaceDir });
    const result = await handleLeanCommand(params, true);

    expect(result?.reply?.text).toContain("/lean runs the full pass by default");
    expect(result?.reply?.text).toContain("🪶 Lean");
  });
});
