import { expect, it, vi } from "vitest";
import { createWorkspaceMemoryFileClient } from "./workspace-memory-client.js";

const note = "/gateway/memory/note.md";
const remoteNote = "/harness/memory/note.md";
type ClientOptions = Parameters<typeof createWorkspaceMemoryFileClient>[0];

function fixture() {
  const controller = new AbortController();
  const request = vi.fn<ClientOptions["request"]>().mockResolvedValue("{}");
  const subscribe = vi.fn<ClientOptions["subscribe"]>().mockResolvedValue(undefined);
  return {
    controller,
    request,
    subscribe,
    files: createWorkspaceMemoryFileClient({
      workspaceDir: "/gateway",
      remoteWorkspaceDir: "/harness",
      signal: controller.signal,
      request,
      subscribe,
    }),
    reply: (result: unknown) => request.mockResolvedValue(JSON.stringify({ result })),
  };
}

it("maps workspace paths while preserving configured external Memory roots", async () => {
  const f = fixture();
  f.reply({ files: [remoteNote, "/archive/note.md"], skipped: ["/harness/memory/skip.md"] });
  const skipped = vi.fn();
  const extraPaths = ["notes", "/gateway/extra", "/archive"];
  const listed = await f.files.listFiles("/gateway", extraPaths, undefined, skipped);
  expect(listed).toEqual([note, "/archive/note.md"]);
  expect(skipped).toHaveBeenCalledWith("/gateway/memory/skip.md");
  f.reply(remoteNote);
  expect(await f.files.maintenance!.resolveWritePath(note)).toBe(note);
  expect(f.request.mock.calls.map(([line]) => JSON.parse(line))).toMatchObject([
    { operation: "list", extraPaths: ["notes", "/harness/extra", "/archive"] },
    { operation: "maintenance", method: "resolveWritePath", args: [remoteNote] },
  ]);
});

it.each([
  undefined,
  '{"result":',
  { message: "content changed", name: "MemoryWriteConflictError", code: "CONFLICT" },
  {
    message: "directory sync failed",
    name: "MemoryAtomicPublicationError",
    publication: "committed",
  },
])("preserves the write outcome for %j", async (response) => {
  const f = fixture();
  const error = typeof response === "object" ? response : undefined;
  const reply = typeof response === "object" ? JSON.stringify({ error: response }) : response;
  if (reply === undefined) {
    f.request.mockRejectedValue(new Error("transport disconnected"));
  } else {
    f.request.mockResolvedValue(reply);
  }
  await expect(
    f.files.maintenance!.commitContent({
      filePath: note,
      tempPrefix: "note",
      content: "update",
      expectedHash: error ? undefined : "old",
    }),
  ).rejects.toMatchObject(error ?? { publication: "uncertain" });
});

it("does not return stale reads or start new requests after its lifetime ends", async () => {
  const f = fixture();
  f.request.mockImplementation(async () => {
    f.controller.abort(new Error("workspace stopped"));
    return JSON.stringify({ result: { content: "obsolete" } });
  });
  await expect(f.files.readForIndexing(note)).rejects.toThrow("workspace stopped");
  await expect(f.files.readForIndexing(note)).rejects.toThrow("workspace stopped");
  expect(f.request).toHaveBeenCalledOnce();
});

it("sends only file-watch settings and reports a lost subscription", async () => {
  const f = fixture();
  const publicSettings = {
    multimodal: { enabled: false, modalities: [], maxFileBytes: 1024 },
    sync: { watchDebounceMs: 10 },
  };
  const settings = {
    ...publicSettings,
    extraPaths: ["/gateway/notes"],
    provider: { apiKey: "synthetic-not-a-credential" },
  };
  f.subscribe.mockImplementation(async (_request, onLine) => onLine('"change"'));
  const onChange = vi.fn();
  await f.files.watch({ agentId: "main", settings }, onChange, new AbortController().signal);
  expect(JSON.parse(f.subscribe.mock.calls[0]![0])).toEqual({
    agentId: "main",
    settings: { ...publicSettings, extraPaths: ["/harness/notes"] },
  });
  expect(onChange.mock.calls).toEqual([["change"], ["unavailable"]]);
});
