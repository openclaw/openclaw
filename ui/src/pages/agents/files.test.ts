import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsFilesGetResult, AgentsFilesSetResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { agentFileValues, setAgentFileValues } from "./agent-file-state.test-helpers.ts";
import { createAgentFileActions, loadAgentFileContent } from "./files.ts";

type FilesState = Parameters<typeof createAgentFileActions>[0];

function createFixture(client: GatewayBrowserClient) {
  const state: FilesState = {
    agentsSelectedId: "main",
    agentFileActive: null,
    client,
    connected: true,
    requestGeneration: 0,
    agents: { recordFile: vi.fn(() => null) },
    agentFilesLoading: false,
    agentFileRead: null,
    agentFileOutcome: null,
    agentFileEditors: {},
    agentFileConflict: null,
    agentFileSaving: false,
    agentFileWriteRevisions: new Map(),
  };
  return { state, actions: createAgentFileActions(state, "main", () => true) };
}

function fileResult(content: string, hash?: string, missing = false): AgentsFilesGetResult {
  return {
    agentId: "main",
    workspace: "workspace",
    file: {
      name: "AGENTS.md",
      path: "AGENTS.md",
      missing,
      content,
      ...(hash ? { hash } : {}),
    },
  };
}

describe("agent file requests", () => {
  it.each(["pending", "failed"] as const)(
    "does not replace an unread file while its initial read is %s, then accepts a loaded empty file",
    async (phase) => {
      const read = createDeferred<AgentsFilesGetResult>();
      const request = vi
        .fn()
        .mockReturnValueOnce(read.promise)
        .mockResolvedValue(fileResult("", "a".repeat(64)));
      const { state, actions } = createFixture(createTestGatewayClient(request));
      const load = loadAgentFileContent(state, "main", "AGENTS.md");
      if (phase === "failed") {
        read.reject(new Error("workspace read failed"));
        expect(await load).toBe(false);
      }

      expect(await actions.onFileSave("AGENTS.md")).toBe(false);
      expect(request).toHaveBeenCalledTimes(1);
      expect(agentFileValues(state, "content")).toEqual({});
      if (phase === "pending") {
        read.resolve(fileResult("", "a".repeat(64)));
        expect(await load).toBe(true);
      } else {
        expect(await state.agentFileOutcome).toEqual({ error: "workspace read failed" });
        expect(await loadAgentFileContent(state, "main", "AGENTS.md")).toBe(true);
      }
      request.mockResolvedValueOnce({
        ok: true,
        ...fileResult("new instructions", "b".repeat(64)),
      });
      actions.onFileDraftChange("AGENTS.md", "new instructions");
      expect(await actions.onFileSave("AGENTS.md")).toBe(true);
      expect(request).toHaveBeenLastCalledWith("agents.files.set", {
        agentId: "main",
        name: "AGENTS.md",
        content: "new instructions",
        expectedWorkspace: "workspace",
        expectedHash: "a".repeat(64),
      });
      expect(state.agentFileEditors["AGENTS.md"]?.content).toBe("new instructions");
    },
  );

  it.each(["", "retained instructions"])(
    "keeps a retained draft editable and guarded by its hash while rereading: %j",
    async (draft) => {
      const read = createDeferred<AgentsFilesGetResult>();
      const request = vi
        .fn()
        .mockReturnValueOnce(read.promise)
        .mockResolvedValue({
          ok: true,
          ...fileResult(draft, "b".repeat(64)),
        });
      const { state, actions } = createFixture(createTestGatewayClient(request));
      setAgentFileValues(state, "draft", { "AGENTS.md": draft });
      setAgentFileValues(state, "version", { "AGENTS.md": { hash: "a".repeat(64) } });
      const load = loadAgentFileContent(state, "main", "AGENTS.md");
      actions.onFileReset("AGENTS.md");
      expect(state.agentFileEditors["AGENTS.md"]?.draft).toBe(draft);
      expect(state.agentFileEditors["AGENTS.md"]?.version).toEqual({ hash: "a".repeat(64) });

      expect(await actions.onFileSave("AGENTS.md")).toBe(true);
      expect(request).toHaveBeenLastCalledWith("agents.files.set", {
        agentId: "main",
        name: "AGENTS.md",
        content: draft,
        expectedHash: "a".repeat(64),
      });
      read.resolve(fileResult("older content", "a".repeat(64)));
      expect(await load).toBe(false);
      expect(state.agentFileEditors["AGENTS.md"]?.draft).toBe(draft);
      expect(state.agentFileEditors["AGENTS.md"]?.content).toBe(draft);
    },
  );

  it.each([false, true])(
    "adopts the refreshed base when Reset replaces a dirty draft (initially missing: %s)",
    async (missing) => {
      const loadedHash = "a".repeat(64);
      const refreshedHash = "b".repeat(64);
      const request = vi
        .fn()
        .mockResolvedValueOnce(
          fileResult(missing ? "" : "original", missing ? undefined : loadedHash, missing),
        )
        .mockResolvedValueOnce(fileResult("external update", refreshedHash))
        .mockResolvedValueOnce({ ok: true, ...fileResult("edited after reset", "c".repeat(64)) });
      const { state, actions } = createFixture(createTestGatewayClient(request));

      await loadAgentFileContent(state, "main", "AGENTS.md");
      setAgentFileValues(state, "draft", { "AGENTS.md": "dirty draft" });
      await loadAgentFileContent(state, "main", "AGENTS.md", { force: true });
      expect(state.agentFileEditors["AGENTS.md"]?.draft).toBe("dirty draft");
      expect(state.agentFileEditors["AGENTS.md"]?.version).toEqual(
        missing ? { missing: true } : { hash: loadedHash },
      );

      actions.onFileReset("AGENTS.md");
      expect(state.agentFileEditors["AGENTS.md"]?.draft).toBe("external update");
      setAgentFileValues(state, "draft", { "AGENTS.md": "edited after reset" });
      await actions.onFileSave("AGENTS.md");

      expect(request).toHaveBeenLastCalledWith("agents.files.set", {
        agentId: "main",
        name: "AGENTS.md",
        content: "edited after reset",
        expectedWorkspace: "workspace",
        expectedHash: refreshedHash,
      });
    },
  );

  it.each(["client", "capability", "generation"] as const)(
    "does not continue Overwrite after its read retires the %s scope",
    async (scope) => {
      const request = vi.fn(async (method: string) =>
        method === "agents.files.get"
          ? fileResult("workspace version", "b".repeat(64))
          : { ok: true, ...fileResult("old draft", "c".repeat(64)) },
      );
      const replacementRequest = vi.fn(async () => ({
        ok: true,
        ...fileResult("old draft", "c".repeat(64)),
      }));
      const { state, actions } = createFixture(createTestGatewayClient(request));
      setAgentFileValues(state, "draft", { "AGENTS.md": "old draft" });
      state.agents.recordFile = vi.fn(() => {
        if (scope === "client") {
          state.client = createTestGatewayClient(replacementRequest);
        } else if (scope === "capability") {
          state.agents = { recordFile: vi.fn() };
        } else {
          state.requestGeneration += 1;
        }
      });

      await actions.onFileOverwrite("AGENTS.md");

      expect(request.mock.calls.map(([method]) => method)).toEqual(["agents.files.get"]);
      expect(replacementRequest).not.toHaveBeenCalled();
    },
  );

  it.each(["read result", "read error"])(
    "retires an older %s after saving the same file",
    async (completion) => {
      const read = createDeferred<AgentsFilesGetResult>();
      const client = {
        request: vi.fn((method: string) =>
          method === "agents.files.get"
            ? read.promise
            : Promise.resolve({ ok: true, ...fileResult("saved") }),
        ),
      } as unknown as GatewayBrowserClient;
      const { state, actions } = createFixture(client);
      setAgentFileValues(state, "content", { "AGENTS.md": "original" });
      setAgentFileValues(state, "draft", { "AGENTS.md": "original" });

      const load = loadAgentFileContent(state, "main", "AGENTS.md", { force: true });
      setAgentFileValues(state, "draft", { "AGENTS.md": "saved" });
      expect(await actions.onFileSave("AGENTS.md")).toBe(true);
      if (completion === "read error") {
        read.reject(new Error("obsolete read failed"));
      } else {
        read.resolve(fileResult("original"));
      }
      expect(await load).toBe(false);
      expect(agentFileValues(state, "content")).toEqual({ "AGENTS.md": "saved" });
      expect(agentFileValues(state, "draft")).toEqual({ "AGENTS.md": "saved" });
      expect(await state.agentFileOutcome).toEqual({ result: true });
      expect(state.agentFilesLoading).toBe(false);
    },
  );

  it.each([false, true])(
    "retires a read started during a write (read fails first: %s)",
    async (readFailsFirst) => {
      const read = createDeferred<AgentsFilesGetResult>();
      const write = createDeferred<AgentsFilesSetResult>();
      const client = {
        request: vi.fn((method: string) =>
          method === "agents.files.get" ? read.promise : write.promise,
        ),
      } as unknown as GatewayBrowserClient;
      const { state, actions } = createFixture(client);
      setAgentFileValues(state, "content", { "AGENTS.md": "original" });
      setAgentFileValues(state, "draft", { "AGENTS.md": "saved" });

      const save = actions.onFileSave("AGENTS.md");
      const load = loadAgentFileContent(state, "main", "AGENTS.md", { force: true });
      if (readFailsFirst) {
        read.reject(new Error("refresh failed"));
        expect(await load).toBe(false);
      }
      write.resolve({ ok: true, ...fileResult("saved") });
      expect(await save).toBe(true);
      if (!readFailsFirst) {
        read.resolve(fileResult("original"));
        expect(await load).toBe(false);
      }
      expect(agentFileValues(state, "content")).toEqual({ "AGENTS.md": "saved" });
      expect(agentFileValues(state, "draft")).toEqual({ "AGENTS.md": "saved" });
      expect(state.agentFilesLoading).toBe(false);
      expect(state.agentFileSaving).toBe(false);
      expect(await state.agentFileOutcome).toEqual({ result: true });
    },
  );

  it("allows another file's read and a fresh post-save refresh", async () => {
    const read = createDeferred<AgentsFilesGetResult>();
    const request = vi
      .fn()
      .mockReturnValueOnce(read.promise)
      .mockResolvedValueOnce({ ok: true, ...fileResult("saved") })
      .mockResolvedValueOnce(fileResult("external update"));
    const { state, actions } = createFixture({ request } as unknown as GatewayBrowserClient);
    setAgentFileValues(state, "content", { "AGENTS.md": "original" });
    const load = loadAgentFileContent(state, "main", "SOUL.md");
    actions.onFileDraftChange("AGENTS.md", "saved");
    await actions.onFileSave("AGENTS.md");
    read.resolve({ ...fileResult("soul"), file: { ...fileResult("soul").file, name: "SOUL.md" } });
    expect(await load).toBe(true);
    expect(agentFileValues(state, "draft")).toEqual({ "AGENTS.md": "saved", "SOUL.md": "soul" });

    expect(await loadAgentFileContent(state, "main", "AGENTS.md", { force: true })).toBe(true);
    expect(state.agentFileEditors["AGENTS.md"]?.draft).toBe("external update");
  });

  it.each(["before", "during"])(
    "keeps a failed save visible after a read starts %s the write",
    async (timing) => {
      const read = createDeferred<AgentsFilesGetResult>();
      const write = createDeferred<AgentsFilesSetResult>();
      const request = vi.fn((method: string) =>
        method === "agents.files.get" ? read.promise : write.promise,
      );
      const { state, actions } = createFixture({ request } as unknown as GatewayBrowserClient);
      setAgentFileValues(state, "content", { "AGENTS.md": "original" });
      setAgentFileValues(state, "draft", { "AGENTS.md": "unsaved" });
      const load =
        timing === "before"
          ? loadAgentFileContent(state, "main", "AGENTS.md", { force: true })
          : null;
      const save = actions.onFileSave("AGENTS.md");
      const refresh = load ?? loadAgentFileContent(state, "main", "AGENTS.md", { force: true });
      write.reject(new Error("workspace write failed"));
      expect(await save).toBe(false);
      read.resolve(fileResult("old"));
      expect(await refresh).toBe(false);
      expect(state.agentFileEditors["AGENTS.md"]?.content).toBe("original");
      expect(state.agentFileEditors["AGENTS.md"]?.draft).toBe("unsaved");
      expect(await state.agentFileOutcome).toEqual({ error: "workspace write failed" });
    },
  );

  it("does not let an old-client read overwrite or finish a replacement read", async () => {
    const oldRead = createDeferred<AgentsFilesGetResult>();
    const nextRead = createDeferred<AgentsFilesGetResult>();
    const oldClient = { request: vi.fn(() => oldRead.promise) } as unknown as GatewayBrowserClient;
    const nextClient = {
      request: vi.fn(() => nextRead.promise),
    } as unknown as GatewayBrowserClient;
    const { state } = createFixture(oldClient);

    const oldLoad = loadAgentFileContent(state, "main", "AGENTS.md");
    state.client = nextClient;
    state.requestGeneration += 1;
    state.agentFilesLoading = false;
    const nextLoad = loadAgentFileContent(state, "main", "AGENTS.md");

    oldRead.resolve(fileResult("old"));
    await oldLoad;
    expect(agentFileValues(state, "content")).toEqual({});
    expect(state.agentFilesLoading).toBe(true);

    nextRead.resolve(fileResult("new"));
    await nextLoad;
    expect(agentFileValues(state, "content")).toEqual({ "AGENTS.md": "new" });
    expect(state.agentFilesLoading).toBe(false);
  });

  it.each(["client", "capability"] as const)("ignores an old-%s save completion", async (owner) => {
    const saved = createDeferred<AgentsFilesSetResult>();
    const oldClient = { request: vi.fn(() => saved.promise) } as unknown as GatewayBrowserClient;
    const { state, actions } = createFixture(oldClient);
    setAgentFileValues(state, "draft", { "AGENTS.md": "old" });
    const save = actions.onFileSave("AGENTS.md");

    if (owner === "client") {
      state.client = { request: vi.fn() } as unknown as GatewayBrowserClient;
      state.requestGeneration += 1;
    } else {
      state.agents = { recordFile: vi.fn() };
    }
    state.agentFileSaving = false;
    saved.resolve({ ok: true, ...fileResult("old") });
    await save;

    expect(agentFileValues(state, "content")).toEqual({});
    expect(state.agentFileSaving).toBe(false);
    expect(state.agents.recordFile).not.toHaveBeenCalled();
  });

  it("preserves edits made while a save is pending", async () => {
    const saved = createDeferred<AgentsFilesSetResult>();
    const client = { request: vi.fn(() => saved.promise) } as unknown as GatewayBrowserClient;
    const { state, actions } = createFixture(client);
    setAgentFileValues(state, "content", { "AGENTS.md": "original" });
    setAgentFileValues(state, "draft", { "AGENTS.md": "submitted" });

    const save = actions.onFileSave("AGENTS.md");
    setAgentFileValues(state, "draft", { "AGENTS.md": "typed while saving" });
    saved.resolve({ ok: true, ...fileResult("submitted") });
    await save;

    expect(agentFileValues(state, "content")).toEqual({ "AGENTS.md": "submitted" });
    expect(agentFileValues(state, "draft")).toEqual({ "AGENTS.md": "typed while saving" });
    expect(state.agentFileSaving).toBe(false);
  });

  it("sends the loaded hash on save and keeps that hash after a refused write", async () => {
    const loadedHash = "a".repeat(64);
    const currentHash = "b".repeat(64);
    const conflict = () =>
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: 'agent file "AGENTS.md" changed since it was read',
        details: { type: "agent_file_conflict", name: "AGENTS.md", currentHash },
      });
    const request = vi
      .fn()
      .mockResolvedValueOnce(fileResult("original", loadedHash))
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(conflict());
    const { state, actions } = createFixture({ request } as unknown as GatewayBrowserClient);

    expect(await loadAgentFileContent(state, "main", "AGENTS.md")).toBe(true);
    setAgentFileValues(state, "draft", { "AGENTS.md": "original\noperator note" });
    expect(await actions.onFileSave("AGENTS.md")).toBe(false);
    expect(await actions.onFileSave("AGENTS.md")).toBe(false);

    const setCall = [
      "agents.files.set",
      {
        agentId: "main",
        name: "AGENTS.md",
        content: "original\noperator note",
        expectedWorkspace: "workspace",
        expectedHash: loadedHash,
      },
    ];
    expect(request.mock.calls[1]).toEqual(setCall);
    expect(request.mock.calls[2]).toEqual(setCall);
    expect(state.agentFileEditors["AGENTS.md"]?.content).toBe("original");
    expect(state.agentFileEditors["AGENTS.md"]?.version).toEqual({ hash: loadedHash });
    expect(state.agentFileEditors["AGENTS.md"]?.draft).toBe("original\noperator note");
    expect(state.agentFileConflict).toBe("AGENTS.md");
    expect((await state.agentFileOutcome)?.error).toContain("changed since it was read");
    expect(state.agentFileSaving).toBe(false);
    expect(state.agentFilesLoading).toBe(false);
  });

  it("keeps a dirty draft's precondition when an ordinary refresh rebases the base", async () => {
    const loadedHash = "a".repeat(64);
    const currentHash = "b".repeat(64);
    const request = vi
      .fn()
      .mockResolvedValueOnce(fileResult("original", loadedHash))
      .mockResolvedValueOnce(fileResult("original\nagent appended", currentHash))
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: 'agent file "AGENTS.md" changed since it was read',
          details: { type: "agent_file_conflict", name: "AGENTS.md", currentHash },
        }),
      );
    const { state, actions } = createFixture({ request } as unknown as GatewayBrowserClient);

    expect(await loadAgentFileContent(state, "main", "AGENTS.md")).toBe(true);
    setAgentFileValues(state, "draft", { "AGENTS.md": "original\noperator note" });
    expect(await loadAgentFileContent(state, "main", "AGENTS.md", { force: true })).toBe(true);

    expect(state.agentFileEditors["AGENTS.md"]?.content).toBe("original\nagent appended");
    expect(state.agentFileEditors["AGENTS.md"]?.draft).toBe("original\noperator note");
    expect(state.agentFileEditors["AGENTS.md"]?.version).toEqual({ hash: loadedHash });

    expect(await actions.onFileSave("AGENTS.md")).toBe(false);

    expect(request.mock.calls[2]).toEqual([
      "agents.files.set",
      {
        agentId: "main",
        name: "AGENTS.md",
        content: "original\noperator note",
        expectedWorkspace: "workspace",
        expectedHash: loadedHash,
      },
    ]);
    expect(state.agentFileConflict).toBe("AGENTS.md");
  });

  it("adopts the refreshed hash when an ordinary refresh rebases a clean draft", async () => {
    const loadedHash = "a".repeat(64);
    const currentHash = "b".repeat(64);
    const request = vi
      .fn()
      .mockResolvedValueOnce(fileResult("original", loadedHash))
      .mockResolvedValueOnce(fileResult("original\nagent appended", currentHash));
    const { state } = createFixture({ request } as unknown as GatewayBrowserClient);

    expect(await loadAgentFileContent(state, "main", "AGENTS.md")).toBe(true);
    expect(await loadAgentFileContent(state, "main", "AGENTS.md", { force: true })).toBe(true);

    expect(state.agentFileEditors["AGENTS.md"]?.draft).toBe("original\nagent appended");
    expect(state.agentFileEditors["AGENTS.md"]?.version).toEqual({ hash: currentHash });
  });

  it("keeps an outstanding conflict through an ordinary refresh that spares the draft", async () => {
    const loadedHash = "a".repeat(64);
    const currentHash = "b".repeat(64);
    const request = vi
      .fn()
      .mockResolvedValueOnce(fileResult("original", loadedHash))
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: 'agent file "AGENTS.md" changed since it was read',
          details: { type: "agent_file_conflict", name: "AGENTS.md", currentHash },
        }),
      )
      .mockResolvedValueOnce(fileResult("original\nagent appended", currentHash));
    const { state, actions } = createFixture({ request } as unknown as GatewayBrowserClient);

    expect(await loadAgentFileContent(state, "main", "AGENTS.md")).toBe(true);
    setAgentFileValues(state, "draft", { "AGENTS.md": "original\noperator note" });
    expect(await actions.onFileSave("AGENTS.md")).toBe(false);
    expect(state.agentFileConflict).toBe("AGENTS.md");

    expect(await loadAgentFileContent(state, "main", "AGENTS.md", { force: true })).toBe(true);

    expect(state.agentFileConflict).toBe("AGENTS.md");
    expect(state.agentFileEditors["AGENTS.md"]?.version).toEqual({ hash: loadedHash });
  });

  it.each([false, true])(
    "takes the workspace version when reloading a conflict (now missing: %s)",
    async (missing) => {
      const loadedHash = "a".repeat(64);
      const currentHash = "b".repeat(64);
      const request = vi
        .fn()
        .mockResolvedValueOnce(fileResult("original", loadedHash))
        .mockRejectedValueOnce(
          new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: 'agent file "AGENTS.md" changed since it was read',
            details: { type: "agent_file_conflict", name: "AGENTS.md", currentHash },
          }),
        )
        .mockResolvedValueOnce(
          fileResult(
            missing ? "" : "original\nagent appended",
            missing ? undefined : currentHash,
            missing,
          ),
        );
      const { state, actions } = createFixture({ request } as unknown as GatewayBrowserClient);

      expect(await loadAgentFileContent(state, "main", "AGENTS.md")).toBe(true);
      setAgentFileValues(state, "draft", { "AGENTS.md": "original\noperator note" });
      expect(await actions.onFileSave("AGENTS.md")).toBe(false);
      expect(await actions.onFileReload("AGENTS.md")).toBe(true);

      expect(request.mock.calls[2]).toEqual([
        "agents.files.get",
        { agentId: "main", name: "AGENTS.md" },
      ]);
      expect(state.agentFileEditors["AGENTS.md"]?.content).toBe(
        missing ? "" : "original\nagent appended",
      );
      expect(state.agentFileEditors["AGENTS.md"]?.draft).toBe(
        missing ? "" : "original\nagent appended",
      );
      expect(state.agentFileEditors["AGENTS.md"]?.version).toEqual(
        missing ? { missing: true } : { hash: currentHash },
      );
      expect(state.agentFileConflict).toBeNull();
    },
  );

  it.each([false, true])(
    "rebases onto the current version when overwriting a conflict (now missing: %s)",
    async (missing) => {
      const loadedHash = "a".repeat(64);
      const currentHash = "b".repeat(64);
      const writtenHash = "c".repeat(64);
      const request = vi
        .fn()
        .mockResolvedValueOnce(fileResult("original", loadedHash))
        .mockRejectedValueOnce(
          new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: 'agent file "AGENTS.md" changed since it was read',
            details: { type: "agent_file_conflict", name: "AGENTS.md", currentHash },
          }),
        )
        .mockResolvedValueOnce(
          fileResult(
            missing ? "" : "original\nagent appended",
            missing ? undefined : currentHash,
            missing,
          ),
        )
        .mockResolvedValueOnce({
          ok: true,
          ...fileResult("original\noperator note", writtenHash),
        });
      const { state, actions } = createFixture({ request } as unknown as GatewayBrowserClient);

      expect(await loadAgentFileContent(state, "main", "AGENTS.md")).toBe(true);
      setAgentFileValues(state, "draft", { "AGENTS.md": "original\noperator note" });
      expect(await actions.onFileSave("AGENTS.md")).toBe(false);
      expect(await actions.onFileOverwrite("AGENTS.md")).toBe(true);

      expect(request.mock.calls[3]).toEqual([
        "agents.files.set",
        {
          agentId: "main",
          name: "AGENTS.md",
          content: "original\noperator note",
          expectedWorkspace: "workspace",
          ...(missing ? { expectedMissing: true } : { expectedHash: currentHash }),
        },
      ]);
      expect(state.agentFileEditors["AGENTS.md"]?.content).toBe("original\noperator note");
      expect(state.agentFileEditors["AGENTS.md"]?.version).toEqual({ hash: writtenHash });
      expect(state.agentFileConflict).toBeNull();
      expect(await state.agentFileOutcome).toEqual({ result: true });
    },
  );
});
