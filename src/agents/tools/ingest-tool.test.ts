import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../memory/search-manager.js", () => {
  return {
    getMemorySearchManager: async () => {
      return { manager: null };
    },
  };
});

import { createIngestLocalFileTool, resolveIngestAllowlistRoot } from "./ingest-tool.js";

describe("ingest_local_file tool", () => {
  let tmpDir: string;
  let ingestRoot: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ingest-test-"));
    ingestRoot = path.join(tmpDir, "ingest-source");
    workspaceDir = path.join(tmpDir, "workspace");
    await fs.mkdir(ingestRoot, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    vi.stubEnv("SOPHIE_INGEST_ROOT", ingestRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function createTool() {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    return createIngestLocalFileTool({
      config: cfg,
      agentSessionKey: "agent:main",
      workspaceDir,
    });
  }

  it("returns null when workspaceDir is not provided", () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const tool = createIngestLocalFileTool({ config: cfg });
    expect(tool).toBeNull();
  });

  it("rejects paths outside allowlist", async () => {
    const tool = createTool();
    expect(tool).not.toBeNull();
    if (!tool) throw new Error("tool missing");

    await expect(tool.execute("call_1", { path: "/etc/passwd" })).rejects.toThrow(
      "Path outside allowlist",
    );
  });

  it("rejects non-.md/.txt files", async () => {
    const pdfPath = path.join(ingestRoot, "doc.pdf");
    await fs.writeFile(pdfPath, "fake pdf content");

    const tool = createTool();
    expect(tool).not.toBeNull();
    if (!tool) throw new Error("tool missing");

    await expect(tool.execute("call_2", { path: pdfPath })).rejects.toThrow(
      "Unsupported file type: .pdf",
    );
  });

  it("copies .md file into memory/ingest/ directory", async () => {
    const srcPath = path.join(ingestRoot, "notes.md");
    await fs.writeFile(srcPath, "# Some notes\nHello world");

    const tool = createTool();
    expect(tool).not.toBeNull();
    if (!tool) throw new Error("tool missing");

    const result = await tool.execute("call_3", { path: srcPath });
    const details = result.details as Record<string, unknown>;

    expect(details.status).toBe("QUEUED");
    expect(details.destination).toBe("memory/ingest/notes.md");
    expect(details.ingest_id).toBeDefined();
    expect(typeof details.ingest_id).toBe("string");
    expect((details.ingest_id as string).startsWith("ingest-")).toBe(true);

    // Verify file was actually written
    const destPath = path.join(workspaceDir, "memory", "ingest", "notes.md");
    const content = await fs.readFile(destPath, "utf-8");
    expect(content).toContain("---\n");
    expect(content).toContain(`ingest_id: ${String(details.ingest_id)}`);
    expect(content).toContain("# Some notes");
    expect(content).toContain("Hello world");
  });

  it("copies .txt file as .md", async () => {
    const srcPath = path.join(ingestRoot, "readme.txt");
    await fs.writeFile(srcPath, "Plain text content");

    const tool = createTool();
    expect(tool).not.toBeNull();
    if (!tool) throw new Error("tool missing");

    const result = await tool.execute("call_4", { path: srcPath });
    const details = result.details as Record<string, unknown>;

    expect(details.destination).toBe("memory/ingest/readme.md");

    const destPath = path.join(workspaceDir, "memory", "ingest", "readme.md");
    const content = await fs.readFile(destPath, "utf-8");
    expect(content).toContain("Plain text content");
  });

  it("merges user metadata and ingest_id into single front-matter block", async () => {
    const srcPath = path.join(ingestRoot, "lease.md");
    await fs.writeFile(srcPath, "Lease document content");

    const tool = createTool();
    expect(tool).not.toBeNull();
    if (!tool) throw new Error("tool missing");

    const result = await tool.execute("call_5", {
      path: srcPath,
      metadata: "source: email\ntags: [lease, property]",
    });
    const details = result.details as Record<string, unknown>;

    const destPath = path.join(workspaceDir, "memory", "ingest", "lease.md");
    const content = await fs.readFile(destPath, "utf-8");

    // Verify single front-matter block with both ingest_id and user metadata
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
    expect(fmMatch).not.toBeNull();
    const frontMatter = fmMatch![1];
    expect(frontMatter).toContain(`ingest_id: ${String(details.ingest_id)}`);
    expect(frontMatter).toContain("source: email");
    expect(frontMatter).toContain("tags: [lease, property]");

    // Verify no double front-matter blocks
    const fmCount = (content.match(/^---$/gm) || []).length;
    expect(fmCount).toBe(2); // opening and closing only
  });

  it("uses custom target_name", async () => {
    const srcPath = path.join(ingestRoot, "original.md");
    await fs.writeFile(srcPath, "Content");

    const tool = createTool();
    expect(tool).not.toBeNull();
    if (!tool) throw new Error("tool missing");

    const result = await tool.execute("call_6", {
      path: srcPath,
      target_name: "renamed",
    });
    const details = result.details as Record<string, unknown>;

    expect(details.destination).toBe("memory/ingest/renamed.md");
    const destPath = path.join(workspaceDir, "memory", "ingest", "renamed.md");
    const stat = await fs.lstat(destPath);
    expect(stat.isFile()).toBe(true);
  });

  it("throws for nonexistent source file", async () => {
    const tool = createTool();
    expect(tool).not.toBeNull();
    if (!tool) throw new Error("tool missing");

    await expect(
      tool.execute("call_7", { path: path.join(ingestRoot, "nope.md") }),
    ).rejects.toThrow("File not found");
  });
});

describe("resolveIngestAllowlistRoot", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses SOPHIE_INGEST_ROOT env var when set", () => {
    vi.stubEnv("SOPHIE_INGEST_ROOT", "/custom/ingest/path");
    expect(resolveIngestAllowlistRoot()).toBe("/custom/ingest/path");
  });

  it("defaults to Documents/SOPHIE_INGEST under home dir", () => {
    vi.stubEnv("SOPHIE_INGEST_ROOT", "");
    const result = resolveIngestAllowlistRoot();
    expect(result).toBe(path.join(os.homedir(), "Documents", "SOPHIE_INGEST"));
  });
});
