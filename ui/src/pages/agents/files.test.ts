import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentsFilesGetResult,
  AgentsFilesListResult,
  AgentsFilesSetResult,
} from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { agentFileValues, setAgentFileValues } from "./agent-file-state.test-helpers.ts";
import { createAgentFilePanel } from "./files.ts";

type FilesState = Parameters<typeof createAgentFilePanel>[0];

function createFixture(request: Parameters<typeof createTestGatewayClient>[0]) {
  const inventory: AgentsFilesListResult = {
    agentId: "main",
    workspace: "workspace",
    files: [{ name: "AGENTS.md", path: "AGENTS.md", missing: false }],
  };
  const state: FilesState = {
    agentsSelectedId: "main",
    agentFileActive: null,
    agentFilesList: null,
    agentsPanel: "files",
    client: createTestGatewayClient(request),
    connected: true,
    requestGeneration: 0,
    agents: {
      recordFile: vi.fn(() => null),
      files: () => ({ list: null, loading: false, read: null }),
      ensureFiles: vi.fn(async () => inventory),
      refreshFiles: vi.fn(async () => inventory),
    },
    agentFilesLoading: false,
    agentFileRead: null,
    agentFileOutcome: null,
    agentFileEditors: {},
    agentFileConflict: null,
    agentFileSaving: false,
    agentFileWriteRevisions: new Map(),
  };
  const files = createAgentFilePanel(state, { canWrite: () => true, isCurrent: () => true });
  const actions = files.forAgent("main");
  async function startRefresh() {
    void actions.onSelectFile("AGENTS.md");
    const previous = state.agentFileRead;
    const refreshing = files.load("main", true);
    // The fixture inventory settles before the panel admits its content read.
    await Promise.resolve();
    const read = state.agentFileRead;
    if (!read || read === previous) {
      throw new Error("Refresh did not admit a content read");
    }
    return {
      completion: Promise.all([refreshing, read]).then(([, outcome]) => outcome.result === true),
    };
  }
  const editor = () => state.agentFileEditors["AGENTS.md"];
  return { state, actions, startRefresh, editor };
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

const loadedHash = "a".repeat(64);
const currentHash = "b".repeat(64);
const writtenHash = "c".repeat(64);
const operatorDraft = "original\noperator note";
const appended = "original\nagent appended";
const conflict = () =>
  new GatewayRequestError({
    code: "INVALID_REQUEST",
    message: 'agent file "AGENTS.md" changed since it was read',
    details: { type: "agent_file_conflict", name: "AGENTS.md", currentHash },
  });
const setCall = (
  content: string,
  version: { expectedHash: string } | { expectedMissing: true } = { expectedHash: loadedHash },
) => [
  "agents.files.set",
  { agentId: "main", name: "AGENTS.md", content, expectedWorkspace: "workspace", ...version },
];

describe("agent file requests", () => {
  it.each(["pending", "failed"] as const)(
    "does not replace an unread file while its initial read is %s, then accepts a loaded empty file",
    async (phase) => {
      const read = createDeferred<AgentsFilesGetResult>();
      const request = vi
        .fn()
        .mockReturnValueOnce(read.promise)
        .mockResolvedValue(fileResult("", loadedHash));
      const { state, actions, editor } = createFixture(request);
      const load = actions.onSelectFile("AGENTS.md");
      if (phase === "failed") {
        read.reject(new Error("workspace read failed"));
        expect(await load).toBe(false);
      }

      expect(await actions.onFileSave("AGENTS.md")).toBe(false);
      expect(request).toHaveBeenCalledTimes(1);
      expect(agentFileValues(state, "content")).toEqual({});
      if (phase === "pending") {
        read.resolve(fileResult("", loadedHash));
        expect(await load).toBe(true);
      } else {
        expect(await state.agentFileOutcome).toEqual({ error: "workspace read failed" });
        expect(await actions.onSelectFile("AGENTS.md")).toBe(true);
      }
      request.mockResolvedValueOnce({
        ok: true,
        ...fileResult("new instructions", currentHash),
      });
      actions.onFileDraftChange("AGENTS.md", "new instructions");
      expect(await actions.onFileSave("AGENTS.md")).toBe(true);
      expect(editor()?.content).toBe("new instructions");
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
          ...fileResult(draft, currentHash),
        });
      const { state, actions, editor } = createFixture(request);
      setAgentFileValues(state, "draft", { "AGENTS.md": draft });
      setAgentFileValues(state, "version", { "AGENTS.md": { hash: loadedHash } });
      const load = actions.onSelectFile("AGENTS.md");
      actions.onFileReset("AGENTS.md");
      expect(editor()?.draft).toBe(draft);
      expect(editor()?.version).toEqual({ hash: loadedHash });

      expect(await actions.onFileSave("AGENTS.md")).toBe(true);
      expect(request).toHaveBeenLastCalledWith("agents.files.set", {
        agentId: "main",
        name: "AGENTS.md",
        content: draft,
        expectedHash: loadedHash,
      });
      read.resolve(fileResult("older content", loadedHash));
      expect(await load).toBe(false);
      expect(editor()).toMatchObject({ draft, content: draft });
    },
  );

  it.each([false, true])(
    "adopts the refreshed base when Reset replaces a dirty draft (initially missing: %s)",
    async (missing) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce(
          fileResult(missing ? "" : "original", missing ? undefined : loadedHash, missing),
        )
        .mockResolvedValueOnce(fileResult("external update", currentHash))
        .mockResolvedValueOnce({ ok: true, ...fileResult("edited after reset", writtenHash) });
      const { state, actions, startRefresh, editor } = createFixture(request);

      await actions.onSelectFile("AGENTS.md");
      setAgentFileValues(state, "draft", { "AGENTS.md": "dirty draft" });
      await (
        await startRefresh()
      ).completion;
      expect(editor()?.draft).toBe("dirty draft");
      expect(editor()?.version).toEqual(missing ? { missing: true } : { hash: loadedHash });

      actions.onFileReset("AGENTS.md");
      expect(editor()?.draft).toBe("external update");
      setAgentFileValues(state, "draft", { "AGENTS.md": "edited after reset" });
      await actions.onFileSave("AGENTS.md");

      expect(request).toHaveBeenLastCalledWith("agents.files.set", {
        agentId: "main",
        name: "AGENTS.md",
        content: "edited after reset",
        expectedWorkspace: "workspace",
        expectedHash: currentHash,
      });
    },
  );

  it.each(["client", "capability", "generation"] as const)(
    "does not continue Overwrite after its read retires the %s scope",
    async (scope) => {
      const request = vi.fn(async (method: string) =>
        method === "agents.files.get"
          ? fileResult("workspace version", currentHash)
          : { ok: true, ...fileResult("old draft", writtenHash) },
      );
      const replacementRequest = vi.fn(async () => ({
        ok: true,
        ...fileResult("old draft", writtenHash),
      }));
      const { state, actions } = createFixture(request);
      setAgentFileValues(state, "draft", { "AGENTS.md": "old draft" });
      state.agents.recordFile = vi.fn(() => {
        if (scope === "client") {
          state.client = createTestGatewayClient(replacementRequest);
        } else if (scope === "capability") {
          state.agents = { ...state.agents, recordFile: vi.fn() };
        } else {
          state.requestGeneration += 1;
        }
      });

      await actions.onFileOverwrite("AGENTS.md");

      expect(request.mock.calls.map(([method]) => method)).toEqual(["agents.files.get"]);
      expect(replacementRequest).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["before", "result"],
    ["before", "error"],
    ["during", "result"],
    ["during", "error"],
  ] as const)("retires a read started %s a write, even on read %s", async (timing, outcome) => {
    const read = createDeferred<AgentsFilesGetResult>();
    const write = createDeferred<AgentsFilesSetResult>();
    const request = vi.fn((method: string) =>
      method === "agents.files.get" ? read.promise : write.promise,
    );
    const { state, actions, startRefresh } = createFixture(request);
    setAgentFileValues(state, "content", { "AGENTS.md": "original" });
    setAgentFileValues(state, "draft", { "AGENTS.md": timing === "before" ? "original" : "saved" });
    const firstRead = timing === "before" ? (await startRefresh()).completion : null;
    setAgentFileValues(state, "draft", { "AGENTS.md": "saved" });
    const save = actions.onFileSave("AGENTS.md");
    const load = firstRead ?? (await startRefresh()).completion;
    if (timing === "during" && outcome === "error") {
      read.reject(new Error("refresh failed"));
      expect(await load).toBe(false);
    }
    write.resolve({ ok: true, ...fileResult("saved") });
    expect(await save).toBe(true);
    if (timing === "before" || outcome === "result") {
      if (outcome === "error") {
        read.reject(new Error("obsolete read failed"));
      } else {
        read.resolve(fileResult("original"));
      }
      expect(await load).toBe(false);
    }
    expect(agentFileValues(state, "content")).toEqual({ "AGENTS.md": "saved" });
    expect(agentFileValues(state, "draft")).toEqual({ "AGENTS.md": "saved" });
    expect(state).toMatchObject({ agentFilesLoading: false, agentFileSaving: false });
    expect(await state.agentFileOutcome).toEqual({ result: true });
  });

  it("allows another file's read and a fresh post-save refresh", async () => {
    const read = createDeferred<AgentsFilesGetResult>();
    const request = vi
      .fn()
      .mockReturnValueOnce(read.promise)
      .mockResolvedValueOnce({ ok: true, ...fileResult("saved") })
      .mockResolvedValueOnce(fileResult("external update"));
    const { state, actions, startRefresh, editor } = createFixture(request);
    setAgentFileValues(state, "content", { "AGENTS.md": "original" });
    const load = actions.onSelectFile("SOUL.md");
    actions.onFileDraftChange("AGENTS.md", "saved");
    await actions.onFileSave("AGENTS.md");
    read.resolve({ ...fileResult("soul"), file: { ...fileResult("soul").file, name: "SOUL.md" } });
    expect(await load).toBe(true);
    expect(agentFileValues(state, "draft")).toEqual({ "AGENTS.md": "saved", "SOUL.md": "soul" });

    expect(await (await startRefresh()).completion).toBe(true);
    expect(editor()?.draft).toBe("external update");
  });

  it.each(["before", "during"])(
    "keeps a failed save visible after a read starts %s the write",
    async (timing) => {
      const read = createDeferred<AgentsFilesGetResult>();
      const write = createDeferred<AgentsFilesSetResult>();
      const request = vi.fn((method: string) =>
        method === "agents.files.get" ? read.promise : write.promise,
      );
      const { state, actions, startRefresh, editor } = createFixture(request);
      setAgentFileValues(state, "content", { "AGENTS.md": "original" });
      setAgentFileValues(state, "draft", { "AGENTS.md": "unsaved" });
      const load = timing === "before" ? (await startRefresh()).completion : null;
      const save = actions.onFileSave("AGENTS.md");
      const refresh = load ?? (await startRefresh()).completion;
      write.reject(new Error("workspace write failed"));
      expect(await save).toBe(false);
      read.resolve(fileResult("old"));
      expect(await refresh).toBe(false);
      expect(editor()).toMatchObject({ content: "original", draft: "unsaved" });
      expect(await state.agentFileOutcome).toEqual({ error: "workspace write failed" });
    },
  );

  it("does not let an old-client read overwrite or finish a replacement read", async () => {
    const oldRead = createDeferred<AgentsFilesGetResult>();
    const nextRead = createDeferred<AgentsFilesGetResult>();
    const oldRequest = vi.fn(() => oldRead.promise);
    const nextClient = {
      request: vi.fn(() => nextRead.promise),
    } as unknown as GatewayBrowserClient;
    const { state, actions } = createFixture(oldRequest);

    const oldLoad = actions.onSelectFile("AGENTS.md");
    state.client = nextClient;
    state.requestGeneration += 1;
    state.agentFilesLoading = false;
    const nextLoad = actions.onSelectFile("AGENTS.md");

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
    const oldRequest = vi.fn(() => saved.promise);
    const { state, actions } = createFixture(oldRequest);
    setAgentFileValues(state, "draft", { "AGENTS.md": "old" });
    const save = actions.onFileSave("AGENTS.md");

    if (owner === "client") {
      state.client = { request: vi.fn() } as unknown as GatewayBrowserClient;
      state.requestGeneration += 1;
    } else {
      state.agents = { ...state.agents, recordFile: vi.fn() };
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
    const request = vi.fn(() => saved.promise);
    const { state, actions } = createFixture(request);
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

  it.each([
    ["retry", false],
    ["refresh before save", false],
    ["refresh after conflict", false],
    ["reload", false],
    ["reload", true],
    ["overwrite", false],
    ["overwrite", true],
  ] as const)(
    "preserves conflict ancestry through %s (missing: %s)",
    async (operation, missing) => {
      const request = vi.fn().mockResolvedValueOnce(fileResult("original", loadedHash));
      const refreshed = fileResult(
        missing ? "" : appended,
        missing ? undefined : currentHash,
        missing,
      );
      if (operation === "refresh before save") {
        request.mockResolvedValueOnce(refreshed).mockRejectedValueOnce(conflict());
      } else {
        request.mockRejectedValueOnce(conflict());
        if (operation === "retry") {
          request.mockRejectedValueOnce(conflict());
        } else {
          request.mockResolvedValueOnce(refreshed);
          if (operation === "overwrite") {
            request.mockResolvedValueOnce({ ok: true, ...fileResult(operatorDraft, writtenHash) });
          }
        }
      }
      const { state, actions, startRefresh, editor } = createFixture(request);
      expect(await actions.onSelectFile("AGENTS.md")).toBe(true);
      setAgentFileValues(state, "draft", { "AGENTS.md": operatorDraft });
      if (operation === "refresh before save") {
        expect(await (await startRefresh()).completion).toBe(true);
        expect(editor()).toMatchObject({ content: appended, draft: operatorDraft });
        expect(editor()?.version).toEqual({ hash: loadedHash });
      }
      expect(await actions.onFileSave("AGENTS.md")).toBe(false);
      expect(state.agentFileConflict).toBe("AGENTS.md");

      if (operation === "retry") {
        expect(await actions.onFileSave("AGENTS.md")).toBe(false);
        expect(request.mock.calls.slice(1)).toEqual([
          setCall(operatorDraft),
          setCall(operatorDraft),
        ]);
        expect(editor()).toMatchObject({ content: "original", draft: operatorDraft });
        expect(editor()?.version).toEqual({ hash: loadedHash });
        expect((await state.agentFileOutcome)?.error).toContain("changed since it was read");
        expect(state).toMatchObject({ agentFileSaving: false, agentFilesLoading: false });
      } else if (operation === "refresh after conflict") {
        expect(await (await startRefresh()).completion).toBe(true);
        expect(state.agentFileConflict).toBe("AGENTS.md");
        expect(editor()?.version).toEqual({ hash: loadedHash });
      } else if (operation === "reload") {
        expect(await actions.onFileReload("AGENTS.md")).toBe(true);
        expect(request.mock.calls[2]).toEqual([
          "agents.files.get",
          { agentId: "main", name: "AGENTS.md" },
        ]);
        expect(editor()).toMatchObject({
          content: missing ? "" : appended,
          draft: missing ? "" : appended,
        });
        expect(editor()?.version).toEqual(missing ? { missing: true } : { hash: currentHash });
        expect(state.agentFileConflict).toBeNull();
      } else if (operation === "overwrite") {
        expect(await actions.onFileOverwrite("AGENTS.md")).toBe(true);
        expect(request.mock.calls[3]).toEqual(
          setCall(
            operatorDraft,
            missing ? { expectedMissing: true } : { expectedHash: currentHash },
          ),
        );
        expect(editor()?.content).toBe(operatorDraft);
        expect(editor()?.version).toEqual({ hash: writtenHash });
        expect(state.agentFileConflict).toBeNull();
        expect(await state.agentFileOutcome).toEqual({ result: true });
      }
    },
  );

  it("adopts the refreshed hash when an ordinary refresh rebases a clean draft", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(fileResult("original", loadedHash))
      .mockResolvedValueOnce(fileResult(appended, currentHash));
    const { actions, startRefresh, editor } = createFixture(request);
    expect(await actions.onSelectFile("AGENTS.md")).toBe(true);
    expect(await (await startRefresh()).completion).toBe(true);
    expect(editor()?.draft).toBe(appended);
    expect(editor()?.version).toEqual({ hash: currentHash });
  });
});
