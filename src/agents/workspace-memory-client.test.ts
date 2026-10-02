import { describe, expect, it, vi } from "vitest";
import { createWorkspaceMemoryFileClient } from "./workspace-memory-client.js";

function fixture() {
  const controller = new AbortController();
  const request = vi.fn(async (_request: string, _signal: AbortSignal) => "{}");
  const subscribe = vi.fn(
    async (_request: string, _onLine: (line: string) => void, _signal: AbortSignal) => {},
  );
  const files = createWorkspaceMemoryFileClient({
    workspaceDir: "/gateway",
    remoteWorkspaceDir: "/harness",
    signal: controller.signal,
    request,
    subscribe,
  });
  return { controller, request, subscribe, files };
}

describe("workspace Memory file client", () => {
  it("maps workspace paths while preserving configured external Memory roots", async () => {
    const f = fixture();
    f.request.mockResolvedValue(
      JSON.stringify({
        result: {
          files: ["/harness/memory/note.md", "/archive/note.md"],
          skipped: ["/harness/memory/skip.md"],
        },
      }),
    );
    const skipped = vi.fn();
    expect(
      await f.files.listFiles(
        "/gateway",
        ["notes", "/gateway/extra", "/archive"],
        undefined,
        skipped,
      ),
    ).toEqual(["/gateway/memory/note.md", "/archive/note.md"]);
    expect(skipped).toHaveBeenCalledWith("/gateway/memory/skip.md");
    expect(JSON.parse(f.request.mock.calls[0]![0])).toMatchObject({
      operation: "list",
      extraPaths: ["notes", "/harness/extra", "/archive"],
    });
    f.request.mockResolvedValue(JSON.stringify({ result: "/harness/memory/note.md" }));
    expect(await f.files.maintenance!.resolveWritePath("/gateway/memory/note.md")).toBe(
      "/gateway/memory/note.md",
    );
    expect(JSON.parse(f.request.mock.calls[1]![0])).toMatchObject({
      operation: "maintenance",
      method: "resolveWritePath",
      args: ["/harness/memory/note.md"],
    });
  });

  it.each(["disconnect", "truncated reply"])(
    "keeps a conditional write outcome uncertain after %s",
    async (failure) => {
      const f = fixture();
      if (failure === "disconnect") {
        f.request.mockRejectedValue(new Error("transport disconnected"));
      } else {
        f.request.mockResolvedValue('{"result":');
      }
      await expect(
        f.files.maintenance!.commitContent({
          filePath: "/gateway/memory/note.md",
          tempPrefix: "note",
          content: "update",
          expectedHash: "old",
        }),
      ).rejects.toMatchObject({ publication: "uncertain" });
    },
  );

  it("preserves the native worker's conflict and publication errors", async () => {
    const f = fixture();
    for (const error of [
      { message: "content changed", name: "MemoryWriteConflictError", code: "CONFLICT" },
      {
        message: "directory sync failed",
        name: "MemoryAtomicPublicationError",
        publication: "committed",
      },
    ]) {
      f.request.mockResolvedValue(JSON.stringify({ error }));
      await expect(
        f.files.maintenance!.commitContent({
          filePath: "/gateway/memory/note.md",
          tempPrefix: "note",
          content: "update",
        }),
      ).rejects.toMatchObject(error);
    }
  });

  it("does not return stale reads or start new requests after its lifetime ends", async () => {
    const f = fixture();
    f.request.mockImplementation(async () => {
      f.controller.abort(new Error("workspace stopped"));
      return JSON.stringify({ result: { content: "obsolete" } });
    });
    await expect(f.files.readForIndexing("/gateway/memory/note.md")).rejects.toThrow(
      "workspace stopped",
    );
    await expect(f.files.readForIndexing("/gateway/memory/note.md")).rejects.toThrow(
      "workspace stopped",
    );
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("sends only file-watch settings and reports a lost subscription", async () => {
    const f = fixture();
    const settings = {
      extraPaths: ["/gateway/notes"],
      multimodal: { enabled: false, modalities: [], maxFileBytes: 1024 },
      sync: { watchDebounceMs: 10 },
      provider: { apiKey: "synthetic-not-a-credential" },
    };
    f.subscribe.mockImplementation(async (_request, onLine) => {
      onLine('"change"');
    });
    const onChange = vi.fn();
    await f.files.watch({ agentId: "main", settings }, onChange, new AbortController().signal);
    expect(JSON.parse(f.subscribe.mock.calls[0]![0])).toEqual({
      agentId: "main",
      settings: {
        extraPaths: ["/harness/notes"],
        multimodal: settings.multimodal,
        sync: { watchDebounceMs: 10 },
      },
    });
    expect(onChange.mock.calls).toEqual([["change"], ["unavailable"]]);
  });
});
