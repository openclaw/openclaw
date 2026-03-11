import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetWorkspaceTemplateDirCache,
  resolveWorkspaceTemplateDir,
} from "./workspace-templates.js";

const tempDirs: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-templates-"));
  tempDirs.push(root);
  return root;
}

describe("resolveWorkspaceTemplateDir", () => {
  afterEach(async () => {
    resetWorkspaceTemplateDirCache();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("resolves templates from package root when module url is dist-rooted", async () => {
    const root = await makeTempRoot();
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));

    const templatesDir = path.join(root, "docs", "reference", "templates");
    await fs.mkdir(templatesDir, { recursive: true });
    await fs.writeFile(path.join(templatesDir, "AGENTS.md"), "# ok\n");

    const distDir = path.join(root, "dist");
    await fs.mkdir(distDir, { recursive: true });
    const moduleUrl = pathToFileURL(path.join(distDir, "model-selection.mjs")).toString();

    const resolved = await resolveWorkspaceTemplateDir({ cwd: distDir, moduleUrl });
    expect(resolved).toBe(templatesDir);
  });

  it("falls back to package-root docs path when templates directory is missing", async () => {
    const root = await makeTempRoot();
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));

    const distDir = path.join(root, "dist");
    await fs.mkdir(distDir, { recursive: true });
    const moduleUrl = pathToFileURL(path.join(distDir, "model-selection.mjs")).toString();

    const resolved = await resolveWorkspaceTemplateDir({ cwd: distDir, moduleUrl });
    expect(path.normalize(resolved)).toBe(path.resolve("docs", "reference", "templates"));
  });

  it("resolves via module-relative ../docs fallback when packageRoot is null and cwd lacks templates", async () => {
    // Simulates the bundled dist/ layout where ../../ overshoots but ../ is correct.
    // When resolveOpenClawPackageRoot returns null (no package.json in ancestors),
    // the ../docs/reference/templates fallback relative to the module should work.
    const root = await makeTempRoot();
    // No package.json — packageRoot will be null

    const distDir = path.join(root, "dist");
    await fs.mkdir(distDir, { recursive: true });

    // Create templates at ../docs (one level up from dist/) — the bundled layout
    const templatesDir = path.join(root, "docs", "reference", "templates");
    await fs.mkdir(templatesDir, { recursive: true });
    await fs.writeFile(path.join(templatesDir, "AGENTS.md"), "# ok\n");

    const moduleUrl = pathToFileURL(path.join(distDir, "workspace-XXXX.mjs")).toString();
    // Use a cwd that does NOT have docs/reference/templates
    const fakeCwd = await makeTempRoot();

    const resolved = await resolveWorkspaceTemplateDir({ cwd: fakeCwd, moduleUrl });
    expect(resolved).toBe(templatesDir);
  });
});
