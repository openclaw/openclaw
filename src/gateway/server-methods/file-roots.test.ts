import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileRootsHandlers } from "./file-roots.js";

function createResponder() {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  return {
    calls,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      calls.push({ ok, payload, error });
    },
  };
}

type FileRootMethod = "files.roots.list" | "files.root.list" | "files.root.get";

async function invokeFileRootHandler(
  method: FileRootMethod,
  params: Record<string, unknown>,
  config: Record<string, unknown>,
) {
  const responder = createResponder();
  await fileRootsHandlers[method]?.({
    req: { type: "req", id: method, method, params: {} },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: responder.respond,
    context: { getRuntimeConfig: () => config } as never,
  });
  return responder.calls;
}

function expectOkPayload(calls: ReturnType<typeof createResponder>["calls"]): Record<string, any> {
  expect(calls).toHaveLength(1);
  expect(calls[0]?.ok).toBe(true);
  return calls[0]?.payload as Record<string, any>;
}

function expectError(calls: ReturnType<typeof createResponder>["calls"]): Record<string, any> {
  expect(calls).toHaveLength(1);
  expect(calls[0]?.ok).toBe(false);
  return calls[0]?.error as Record<string, any>;
}

function writeFile(root: string, filePath: string, content: string | Buffer) {
  const resolved = path.join(root, filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content);
}

describe("file-root RPC handlers", () => {
  let root: string;
  let config: Record<string, unknown>;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-file-root-test-")));
    writeFile(root, "notes.md", "# Notes\n");
    writeFile(root, "src/index.ts", "export const ok = true;\n");
    writeFile(root, ".git/config", "private\n");
    writeFile(root, ".hidden.md", "private\n");
    config = {
      gateway: {
        fileRoots: {
          notes: { label: "Notes", path: root, readOnly: true },
          missing: { label: "Missing", path: path.join(root, "missing"), readOnly: true },
        },
      },
    };
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("lists configured roots without exposing host paths", async () => {
    const payload = expectOkPayload(await invokeFileRootHandler("files.roots.list", {}, config));
    expect(payload.roots).toEqual([
      { id: "notes", label: "Notes", available: true },
      { id: "missing", label: "Missing", available: false },
    ]);
    expect(JSON.stringify(payload)).not.toContain(root);
  });

  it("treats Object.prototype root IDs as unconfigured roots", async () => {
    const error = expectError(
      await invokeFileRootHandler("files.root.list", { rootId: "constructor" }, config),
    );
    expect(error.details).toMatchObject({
      rootId: "constructor",
      type: "file_root_not_found",
    });
  });

  it("lists visible entries with directories first", async () => {
    const payload = expectOkPayload(
      await invokeFileRootHandler("files.root.list", { rootId: "notes" }, config),
    );
    expect(payload).toMatchObject({ rootId: "notes", path: "", totalEntries: 2, offset: 0 });
    expect(
      payload.entries.map((entry: Record<string, unknown>) => [entry.path, entry.kind]),
    ).toEqual([
      ["src", "directory"],
      ["notes.md", "file"],
    ]);
  });

  it("reads a file through the same safe root used for stat", async () => {
    const payload = expectOkPayload(
      await invokeFileRootHandler("files.root.get", { rootId: "notes", path: "notes.md" }, config),
    );
    expect(payload.file).toMatchObject({
      path: "notes.md",
      encoding: "utf8",
      content: "# Notes\n",
    });
  });

  it.each([".git/config", ".hidden.md"])(
    "hides metadata from direct reads: %s",
    async (filePath) => {
      const error = expectError(
        await invokeFileRootHandler("files.root.get", { rootId: "notes", path: filePath }, config),
      );
      expect(error.details).toMatchObject({
        rootId: "notes",
        path: filePath,
        type: "file_root_path_hidden",
      });
    },
  );

  it.each(["../outside.txt", "/etc/passwd", "C:\\Windows\\System32\\drivers\\etc\\hosts"])(
    "rejects paths outside the named root: %s",
    async (filePath) => {
      const error = expectError(
        await invokeFileRootHandler("files.root.get", { rootId: "notes", path: filePath }, config),
      );
      expect(error.details.type).toBe("file_root_path_invalid");
    },
  );

  it("rejects symlink and hardlink escapes", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-file-root-outside-"));
    writeFile(outside, "secret.txt", "outside\n");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "linked.txt"));
    const outsideHardlink = path.join(outside, "hardlink.txt");
    fs.writeFileSync(outsideHardlink, "shared\n");
    fs.linkSync(outsideHardlink, path.join(root, "shared.txt"));
    try {
      for (const filePath of ["linked.txt", "shared.txt"]) {
        const error = expectError(
          await invokeFileRootHandler(
            "files.root.get",
            { rootId: "notes", path: filePath },
            config,
          ),
        );
        expect(error.details.type).toBe("file_root_file_not_found");
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
