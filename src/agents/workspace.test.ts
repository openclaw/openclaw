import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureAgentWorkspace } from "./workspace.js";

describe("ensureAgentWorkspace", () => {
  it("creates directory and bootstrap files when missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-ws-"));
    const nested = path.join(dir, "nested");
    const result = await ensureAgentWorkspace({
      dir: nested,
      ensureBootstrapFiles: true,
    });
    expect(result.dir).toBe(path.resolve(nested));
    expect(result.agentsPath).toBe(
      path.join(path.resolve(nested), "AGENTS.md"),
    );
    expect(result.agentsPath).toBeDefined();
    if (!result.agentsPath) throw new Error("agentsPath missing");
    const content = await fs.readFile(result.agentsPath, "utf-8");
    expect(content).toContain("# AGENTS.md");

    const identity = path.join(path.resolve(nested), "IDENTITY.md");
    const user = path.join(path.resolve(nested), "USER.md");
    const bootstrap = path.join(path.resolve(nested), "BOOTSTRAP.md");
    await expect(fs.stat(identity)).resolves.toBeDefined();
    await expect(fs.stat(user)).resolves.toBeDefined();
    await expect(fs.stat(bootstrap)).resolves.toBeDefined();
  });

  it("does not overwrite existing AGENTS.md", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-ws-"));
    const agentsPath = path.join(dir, "AGENTS.md");
    await fs.writeFile(agentsPath, "custom", "utf-8");
    await ensureAgentWorkspace({ dir, ensureBootstrapFiles: true });
    expect(await fs.readFile(agentsPath, "utf-8")).toBe("custom");
  });
});
