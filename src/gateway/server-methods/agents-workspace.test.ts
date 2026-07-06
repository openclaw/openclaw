// Read-only agent workspace browser tests cover bounded listing, type-gated
// reads, and root-confinement negatives (traversal, absolute paths, symlinks).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsWorkspaceHandlers } from "./agents-workspace.js";

const hoisted = vi.hoisted(() => ({
  listAgentIds: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: hoisted.listAgentIds,
  resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
}));

type WorkspaceMethod = "agents.workspace.list" | "agents.workspace.read";

async function invokeWorkspaceHandler(method: WorkspaceMethod, params: Record<string, unknown>) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  await agentsWorkspaceHandlers[method]?.({
    req: { type: "req", id: method, method, params: {} },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      calls.push({ ok, payload, error });
    },
    context: { getRuntimeConfig: () => ({}) } as never,
  });
  return calls;
}

function expectOkPayload(calls: Awaited<ReturnType<typeof invokeWorkspaceHandler>>) {
  expect(calls).toHaveLength(1);
  expect(calls[0]?.ok).toBe(true);
  return calls[0]?.payload as Record<string, any>;
}

function expectErrorType(
  calls: Awaited<ReturnType<typeof invokeWorkspaceHandler>>,
  type: string,
): Record<string, any> {
  expect(calls).toHaveLength(1);
  expect(calls[0]?.ok).toBe(false);
  const error = calls[0]?.error as { details?: { type?: string } };
  expect(error?.details?.type).toBe(type);
  return error as Record<string, any>;
}

// 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("agents.workspace RPC handlers", () => {
  let outsideDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    // macOS os.tmpdir() is a /var -> /private/var symlink; fs-safe resolves the
    // canonical path, so anchor assertions on the realpathed root.
    outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ws-outside-")));
    workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ws-test-")));
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "top secret\n", "utf8");
    fs.mkdirSync(path.join(workspaceRoot, "notes"));
    fs.writeFileSync(path.join(workspaceRoot, "notes", "todo.md"), "# Todo\n", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "report.txt"), "hello workspace\n", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "pixel.png"), Buffer.from(PNG_BASE64, "base64"));
    fs.symlinkSync(path.join(outsideDir, "secret.txt"), path.join(workspaceRoot, "escape.txt"));
    hoisted.listAgentIds.mockReturnValue(["main"]);
    hoisted.resolveAgentWorkspaceDir.mockReturnValue(workspaceRoot);
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  describe("agents.workspace.list", () => {
    it("lists the workspace root with directories first and hides symlinks", async () => {
      const payload = expectOkPayload(
        await invokeWorkspaceHandler("agents.workspace.list", { agentId: "main" }),
      );
      expect(payload.agentId).toBe("main");
      expect(payload.workspace).toBe(workspaceRoot);
      expect(payload.path).toBe("");
      expect(payload.parentPath).toBeUndefined();
      expect(payload.entries.map((entry: { path: string }) => entry.path)).toEqual([
        "notes",
        "pixel.png",
        "report.txt",
      ]);
      expect(payload.entries[0]).toMatchObject({ name: "notes", kind: "directory" });
      expect(payload.entries[2]).toMatchObject({
        name: "report.txt",
        kind: "file",
        size: "hello workspace\n".length,
      });
    });

    it("lists a subdirectory with parentPath and paginates via offset", async () => {
      const payload = expectOkPayload(
        await invokeWorkspaceHandler("agents.workspace.list", { agentId: "main", path: "notes" }),
      );
      expect(payload.path).toBe("notes");
      expect(payload.parentPath).toBe("");
      expect(payload.entries).toEqual([
        expect.objectContaining({ path: "notes/todo.md", kind: "file" }),
      ]);

      const offsetPayload = expectOkPayload(
        await invokeWorkspaceHandler("agents.workspace.list", { agentId: "main", offset: 1 }),
      );
      expect(offsetPayload.entries.map((entry: { path: string }) => entry.path)).toEqual([
        "pixel.png",
        "report.txt",
      ]);
      expect(offsetPayload.truncated).toBeUndefined();
    });

    it("rejects traversal and absolute paths", async () => {
      expectErrorType(
        await invokeWorkspaceHandler("agents.workspace.list", {
          agentId: "main",
          path: "../" + path.basename(outsideDir),
        }),
        "workspace_path_invalid",
      );
      expectErrorType(
        await invokeWorkspaceHandler("agents.workspace.list", {
          agentId: "main",
          path: outsideDir,
        }),
        "workspace_path_invalid",
      );
    });

    it("rejects unknown agent ids", async () => {
      const calls = await invokeWorkspaceHandler("agents.workspace.list", { agentId: "ghost" });
      expect(calls[0]?.ok).toBe(false);
    });
  });

  describe("agents.workspace.read", () => {
    it("returns UTF-8 text inline", async () => {
      const payload = expectOkPayload(
        await invokeWorkspaceHandler("agents.workspace.read", {
          agentId: "main",
          path: "report.txt",
        }),
      );
      expect(payload.file).toMatchObject({
        path: "report.txt",
        name: "report.txt",
        encoding: "utf8",
        mimeType: "text/plain",
        content: "hello workspace\n",
      });
    });

    it("returns images as base64 with a mime type", async () => {
      const payload = expectOkPayload(
        await invokeWorkspaceHandler("agents.workspace.read", {
          agentId: "main",
          path: "pixel.png",
        }),
      );
      expect(payload.file.encoding).toBe("base64");
      expect(payload.file.mimeType).toBe("image/png");
      expect(payload.file.content).toBe(PNG_BASE64);
    });

    it("rejects traversal, absolute paths, and symlink escapes", async () => {
      expectErrorType(
        await invokeWorkspaceHandler("agents.workspace.read", {
          agentId: "main",
          path: `../${path.basename(outsideDir)}/secret.txt`,
        }),
        "workspace_path_invalid",
      );
      expectErrorType(
        await invokeWorkspaceHandler("agents.workspace.read", {
          agentId: "main",
          path: path.join(outsideDir, "secret.txt"),
        }),
        "workspace_path_invalid",
      );
      // In-root symlink pointing outside the root must not be readable.
      const symlinkCalls = await invokeWorkspaceHandler("agents.workspace.read", {
        agentId: "main",
        path: "escape.txt",
      });
      expect(symlinkCalls[0]?.ok).toBe(false);
    });

    it("rejects non-image binary files", async () => {
      fs.writeFileSync(path.join(workspaceRoot, "blob.bin"), Buffer.from([0, 1, 2, 3]));
      expectErrorType(
        await invokeWorkspaceHandler("agents.workspace.read", {
          agentId: "main",
          path: "blob.bin",
        }),
        "workspace_file_unsupported",
      );
    });

    it("rejects text files above the read cap", async () => {
      fs.writeFileSync(path.join(workspaceRoot, "big.log"), "x".repeat(256 * 1024 + 1), "utf8");
      const error = expectErrorType(
        await invokeWorkspaceHandler("agents.workspace.read", {
          agentId: "main",
          path: "big.log",
        }),
        "workspace_file_too_large",
      );
      expect(error.details.maxBytes).toBe(256 * 1024);
    });

    it("reports missing files", async () => {
      expectErrorType(
        await invokeWorkspaceHandler("agents.workspace.read", {
          agentId: "main",
          path: "nope.txt",
        }),
        "workspace_path_not_found",
      );
    });
  });
});
