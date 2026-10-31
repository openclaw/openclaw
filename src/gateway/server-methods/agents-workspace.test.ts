import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callAgentHandler } from "./agents-mutate.test-support.js";
import { agentsWorkspaceHandlers } from "./agents-workspace.js";

const hoisted = vi.hoisted(() => ({ listAgentIds: vi.fn(), resolveAgentWorkspaceDir: vi.fn() }));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  ...hoisted,
}));

type WorkspaceMethod = "agents.workspace.list" | "agents.workspace.get";

async function invokeWorkspaceHandler(
  method: WorkspaceMethod,
  params: Record<string, unknown>,
  ok = true,
): Promise<Record<string, any>> {
  const respond = await callAgentHandler(agentsWorkspaceHandlers[method]!, method, params, {
    context: { getRuntimeConfig: () => ({}) } as never,
  });
  expect(respond).toHaveBeenCalledTimes(1);
  const [succeeded, payload, error] = expectDefined(respond.mock.calls[0], "workspace response");
  expect(succeeded).toBe(ok);
  return (ok ? payload : error) as Record<string, any>;
}

function getWorkspaceFile(filePath: string) {
  return invokeWorkspaceHandler("agents.workspace.get", { agentId: "main", path: filePath });
}

function listWorkspace(params: Record<string, unknown> = {}, ok = true) {
  return invokeWorkspaceHandler("agents.workspace.list", { agentId: "main", ...params }, ok);
}

async function expectFileError(filePath: string, details: Record<string, unknown>) {
  const error = await invokeWorkspaceHandler(
    "agents.workspace.get",
    { agentId: "main", path: filePath },
    false,
  );
  expect(error.details).toMatchObject(details);
}

describe("agents.workspace RPC handlers", () => {
  let testRoot: string;
  let workspaceRoot: string;
  function writeFile(filePath: string, content: string | Buffer) {
    const resolved = path.join(workspaceRoot, filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Realpath the tmp root: macOS os.tmpdir() is a /var -> /private/var symlink
    // and fs-safe compares against the canonical root.
    testRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agents-workspace-test-")),
    );
    workspaceRoot = path.join(testRoot, "workspace");
    fs.mkdirSync(workspaceRoot);
    hoisted.listAgentIds.mockReturnValue(["main"]);
    hoisted.resolveAgentWorkspaceDir.mockReturnValue(workspaceRoot);
    writeFile("notes.md", "# Notes\n");
    writeFile(".gitignore", "dist\n");
    writeFile("src/index.ts", "export const ok = true;\n");
    writeFile("src/util.ts", "export const util = 1;\n");
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("lists the root and opens a dot-prefixed workspace directory", async () => {
    writeFile("..notes/index.ts", "export const ok = true;\n");
    writeFile("..notes/util.ts", "export const util = 1;\n");
    const root = await listWorkspace();
    expect(root).toMatchObject({ path: "", totalEntries: 4, offset: 0 });
    expect(root.parentPath).toBeUndefined();
    expect(
      root.entries.map(({ path: entryPath, kind }: Record<string, unknown>) => [entryPath, kind]),
    ).toEqual([
      ["..notes", "directory"],
      ["src", "directory"],
      [".gitignore", "file"],
      ["notes.md", "file"],
    ]);
    const file = root.entries.find((entry: Record<string, unknown>) => entry.path === "notes.md");
    expect(file.size).toBeGreaterThan(0);
    expect(Number.isInteger(file.updatedAtMs)).toBe(true);
    const nested = await listWorkspace({ path: root.entries[0].path });
    expect(nested).toMatchObject({ path: "..notes", parentPath: "", totalEntries: 2, offset: 0 });
    expect(
      nested.entries.map(({ path: entryPath, kind }: Record<string, unknown>) => [entryPath, kind]),
    ).toEqual([
      ["..notes/index.ts", "file"],
      ["..notes/util.ts", "file"],
    ]);
    expect((await getWorkspaceFile(nested.entries[0].path)).file.content).toBe(
      "export const ok = true;\n",
    );
  });
  it("rejects unknown agents", async () => {
    const error = await listWorkspace({ agentId: "ghost" }, false);
    expect(error.message).toContain('agent "ghost" not found');
  });

  it("rejects traversal outside the workspace for list and get", async () => {
    const listError = await listWorkspace({ path: "../" }, false);
    expect(listError.details).toMatchObject({ type: "workspace_path_invalid" });

    await expectFileError("../outside.txt", { type: "workspace_path_invalid" });
  });

  it.each(["/etc/passwd", "C:\\Windows\\System32\\drivers\\etc\\hosts"])(
    "rejects absolute workspace paths: %s",
    async (filePath) => {
      await expectFileError(filePath, { path: filePath, type: "workspace_path_invalid" });
    },
  );

  it.each(["symlink", "hardlink"] as const)("rejects outside %s files", async (kind) => {
    const outsidePath = path.join(testRoot, "outside.txt");
    fs.writeFileSync(outsidePath, "outside\n", "utf8");
    const link = kind === "symlink" ? fs.symlinkSync : fs.linkSync;
    link(outsidePath, path.join(workspaceRoot, "linked.txt"));
    await expectFileError("linked.txt", { path: "linked.txt", type: "workspace_file_not_found" });
  });

  it("does not follow symlinked directories out of the workspace", async () => {
    const outsideDir = path.join(testRoot, "outside");
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "outside secret\n");
    fs.symlinkSync(outsideDir, path.join(workspaceRoot, "linked-dir"), "dir");

    const listError = await listWorkspace({ path: "linked-dir" }, false);
    expect(listError.details).toMatchObject({ type: "workspace_path_not_found" });
    await expectFileError("linked-dir/secret.txt", { type: "workspace_file_not_found" });
  });

  it("reads images as base64 with their sniffed mime type", async () => {
    // 1x1 transparent PNG so magic-byte sniffing sees a real image payload.
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFile("shot.png", pngBytes);

    const payload = await getWorkspaceFile("shot.png");

    expect(payload.file).toMatchObject({
      encoding: "base64",
      mimeType: "image/png",
      size: pngBytes.length,
    });
    expect(Buffer.from(payload.file.content, "base64")).toEqual(pngBytes);
  });

  it("refuses non-image binaries renamed to an image extension", async () => {
    writeFile(
      "disguised.png",
      Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(64, 7)]),
    );

    await expectFileError("disguised.png", {
      path: "disguised.png",
      type: "workspace_file_unsupported",
    });
  });

  it.each([
    { name: "large.log", maxBytes: 256 * 1024, size: 260 * 1024 },
    { name: "large.png", maxBytes: 5 * 1024 * 1024, size: 5 * 1024 * 1024 + 1 },
  ])("reports the preview cap for $name", async ({ name, maxBytes, size }) => {
    writeFile(name, name.endsWith(".png") ? Buffer.alloc(size) : "x".repeat(size));
    await expectFileError(name, {
      maxBytes,
      path: name,
      size,
      type: "workspace_file_too_large",
    });
  });
});
