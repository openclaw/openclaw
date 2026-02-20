import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resetWorkspaceTemplateDirCache,
  resolveWorkspaceTemplateDir,
} from "./workspace-templates.js";

async function makeTempRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tpl-ancestor-"));
}

describe("resolveWorkspaceTemplateDir ancestor walk", () => {
  it("finds templates when module is nested one level deep (dist/)", async () => {
    resetWorkspaceTemplateDirCache();
    const root = await makeTempRoot();
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));

    const templatesDir = path.join(root, "docs", "reference", "templates");
    await fs.mkdir(templatesDir, { recursive: true });
    await fs.writeFile(path.join(templatesDir, "TOOLS.md"), "# tools\n");

    const distDir = path.join(root, "dist");
    await fs.mkdir(distDir, { recursive: true });
    const moduleUrl = pathToFileURL(path.join(distDir, "workspace.js")).toString();

    const resolved = await resolveWorkspaceTemplateDir({ cwd: root, moduleUrl });
    expect(resolved).toBe(templatesDir);
  });

  it("finds templates when module is nested two levels deep (src/agents/)", async () => {
    resetWorkspaceTemplateDirCache();
    const root = await makeTempRoot();
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));

    const templatesDir = path.join(root, "docs", "reference", "templates");
    await fs.mkdir(templatesDir, { recursive: true });
    await fs.writeFile(path.join(templatesDir, "TOOLS.md"), "# tools\n");

    const srcDir = path.join(root, "src", "agents");
    await fs.mkdir(srcDir, { recursive: true });
    const moduleUrl = pathToFileURL(path.join(srcDir, "workspace-templates.ts")).toString();

    const resolved = await resolveWorkspaceTemplateDir({ cwd: root, moduleUrl });
    expect(resolved).toBe(templatesDir);
  });

  it("finds templates when cwd is the workspace (not package root)", async () => {
    resetWorkspaceTemplateDirCache();
    const root = await makeTempRoot();
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));

    const templatesDir = path.join(root, "docs", "reference", "templates");
    await fs.mkdir(templatesDir, { recursive: true });
    await fs.writeFile(path.join(templatesDir, "TOOLS.md"), "# tools\n");

    const distDir = path.join(root, "dist");
    await fs.mkdir(distDir, { recursive: true });
    const moduleUrl = pathToFileURL(path.join(distDir, "workspace.js")).toString();

    // cwd is a completely different directory (simulates cron isolated session)
    const fakeCwd = await makeTempRoot();
    const resolved = await resolveWorkspaceTemplateDir({ cwd: fakeCwd, moduleUrl });
    expect(resolved).toBe(templatesDir);
  });
});
