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
});

describe("AGENTS.md template content priority order", () => {
  // Regression for #75187: when users lower agents.defaults.bootstrapMaxChars to fit
  // small/mid model context budgets, head-truncation must preserve the load-bearing
  // safety and tool-use guidance. Keep Red Lines, External vs Internal, and Tools
  // ahead of the longer Memory/Group Chats/Heartbeats sections.
  const templatePath = path.resolve("docs", "reference", "templates", "AGENTS.md");

  async function readH2Order(): Promise<string[]> {
    const content = await fs.readFile(templatePath, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => line.slice("## ".length).trim());
  }

  it("places Red Lines before Memory and Group Chats", async () => {
    const headings = await readH2Order();
    const redLinesIdx = headings.findIndex((h) => h === "Red Lines");
    const memoryIdx = headings.findIndex((h) => h === "Memory");
    const groupChatsIdx = headings.findIndex((h) => h === "Group Chats");
    expect(redLinesIdx).toBeGreaterThanOrEqual(0);
    expect(memoryIdx).toBeGreaterThan(redLinesIdx);
    expect(groupChatsIdx).toBeGreaterThan(redLinesIdx);
  });

  it("places External vs Internal action policy before lower-priority sections", async () => {
    const headings = await readH2Order();
    const externalIdx = headings.findIndex((h) => h === "External vs Internal");
    const memoryIdx = headings.findIndex((h) => h === "Memory");
    expect(externalIdx).toBeGreaterThanOrEqual(0);
    expect(memoryIdx).toBeGreaterThan(externalIdx);
  });

  it("places Tools section before Memory and Group Chats", async () => {
    const headings = await readH2Order();
    const toolsIdx = headings.findIndex((h) => h === "Tools");
    const memoryIdx = headings.findIndex((h) => h === "Memory");
    const groupChatsIdx = headings.findIndex((h) => h === "Group Chats");
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(memoryIdx).toBeGreaterThan(toolsIdx);
    expect(groupChatsIdx).toBeGreaterThan(toolsIdx);
  });

  it("keeps First Run and Session Startup at the very top", async () => {
    const headings = await readH2Order();
    expect(headings[0]).toBe("First Run");
    expect(headings[1]).toBe("Session Startup");
  });
});
