/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  GatewaySessionRow,
  SessionCompactionCheckpoint,
  SessionsListResult,
} from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  getRenderedModalDialog,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import {
  createContext,
  createGateway,
  createRenderedPage,
  createSessions,
  type TestSessionsPage,
} from "./sessions-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
});

type AgentSelectionListeners = {
  state: { selectedId: string | null; scopeId: string | null };
  setScope: (scopeId: string | null) => void;
  subscribe: (listener: () => void) => () => void;
};

function withNotifyingAgentSelection(
  base: ApplicationContext,
  initialScopeId: string | null,
): {
  context: ApplicationContext;
  selection: AgentSelectionListeners;
  changeScope: (next: string | null) => void;
} {
  const listeners = new Set<() => void>();
  const state = { selectedId: base.agentSelection.state.selectedId, scopeId: initialScopeId };
  const selection: AgentSelectionListeners = {
    state,
    setScope: (scopeId) => {
      if (state.scopeId === scopeId) {
        return;
      }
      state.scopeId = scopeId;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const context = {
    ...base,
    agentSelection: {
      ...base.agentSelection,
      state,
      subscribe: selection.subscribe,
      setScope: selection.setScope,
    },
  } as ApplicationContext;
  return {
    context,
    selection,
    changeScope: selection.setScope,
  };
}

async function setupArchivedPageWithSelection(
  scopeId: string | null,
  sessions: SessionCapability,
  expandedSessionKey: string | null = null,
): Promise<{
  page: TestSessionsPage;
  context: ApplicationContext;
  changeScope: (next: string | null) => void;
}> {
  const { gateway } = createGateway({} as GatewayBrowserClient);
  const baseContext = createContext(gateway, sessions);
  const { context, changeScope } = withNotifyingAgentSelection(baseContext, scopeId);
  const page = await createRenderedPage(
    context,
    {
      count: 1,
      sessions: [{ key: "agent:writer:old-1", archived: true }],
    } as SessionsListResult,
    "archived",
    expandedSessionKey,
  );
  return { page, context, changeScope };
}

describe("sessions page agent-scope retirement", () => {
  it.each([false, true])("settles real delete-all confirmation (retire: %s)", async (retire) => {
    const actual = await vi.importActual<typeof import("../../components/confirm-dialog.ts")>(
      "../../components/confirm-dialog.ts",
    );
    vi.mocked(showConfirmDialog).mockImplementation(actual.showConfirmDialog);
    const fixture = createModalDialogTestFixture();
    const list = vi.fn<SessionCapability["list"]>(async (options) =>
      sessionsResult(
        [
          {
            key: `agent:${options?.agentId ?? "main"}:archived`,
            kind: "direct",
            archived: true,
          },
        ],
        1,
      ),
    );
    const deleteMany = vi.fn<SessionCapability["deleteMany"]>().mockResolvedValue({
      deleted: [],
      errors: [],
      preservedWorktrees: [],
    });
    try {
      const { page, changeScope } = await setupArchivedPageWithSelection(
        "writer",
        createSessions({ list, deleteMany }),
      );
      let operation = fixture.track(page.deleteAllArchived());
      let actions = await waitForConfirmDialogActions();
      const { dialog } = await getRenderedModalDialog(document.body);
      expect(dialog.open).toBe(true);

      changeScope(retire ? "main" : "writer");
      if (retire) {
        await vi.waitFor(() =>
          expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull(),
        );
        await operation;
        expect(deleteMany).not.toHaveBeenCalled();
        await page.updateComplete;
        await vi.waitFor(() => expect(page.loading).toBe(false));
        operation = fixture.track(page.deleteAllArchived());
        actions = await waitForConfirmDialogActions();
        const replacement = await getRenderedModalDialog(document.body);
        expect(replacement.dialog.open).toBe(true);
      } else {
        expect(actions.isConnected).toBe(true);
        expect(deleteMany).not.toHaveBeenCalled();
      }

      answerConfirmDialog(actions, "confirm");
      await operation;
      expect(deleteMany).toHaveBeenCalledExactlyOnceWith([
        {
          key: `agent:${retire ? "main" : "writer"}:archived`,
          agentId: undefined,
          archivedOnly: true,
          deleteTranscript: true,
        },
      ]);
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([false, true])(
    "retires pending enumeration after a scope change (return: %s)",
    async (returnToOriginal) => {
      const writerKeys = ["agent:writer:old-1", "agent:writer:old-2"];
      const listResponse = createDeferred<SessionsListResult>();
      const list = vi.fn(() => listResponse.promise) as unknown as SessionCapability["list"];
      const deleteMany = vi.fn(async () => ({
        deleted: writerKeys,
        errors: [],
        preservedWorktrees: [],
      }));
      const sessions = createSessions({
        list,
        deleteMany,
      });
      const { page, changeScope } = await setupArchivedPageWithSelection("writer", sessions);
      vi.mocked(showConfirmDialog).mockResolvedValue(true);

      const operation = page.deleteAllArchived();
      await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
      // The captured scope held `writer`; the operator now switches the page to
      // `main` while the first enumeration page is still in flight.
      changeScope("main");
      if (returnToOriginal) {
        changeScope("writer");
      }
      listResponse.resolve({
        count: writerKeys.length,
        totalCount: writerKeys.length,
        sessions: writerKeys.map((key) => ({
          key,
          kind: "direct",
          updatedAt: 1,
          archived: true,
        })),
      } as SessionsListResult);
      await operation;

      expect(showConfirmDialog).not.toHaveBeenCalled();
      expect(deleteMany).not.toHaveBeenCalled();
      expect(page.error).toBeNull();
    },
  );

  it.each([false, true])(
    "retires pending confirmation after a scope change (return: %s)",
    async (returnToOriginal) => {
      const writerKeys = ["agent:writer:old-1", "agent:writer:old-2"];
      const list = vi.fn(async () => ({
        count: writerKeys.length,
        totalCount: writerKeys.length,
        sessions: writerKeys.map((key) => ({ key, archived: true })),
        hasMore: false,
        nextOffset: null,
      })) as unknown as SessionCapability["list"];
      const deleteMany = vi.fn(async () => ({
        deleted: writerKeys,
        errors: [],
        preservedWorktrees: [],
      }));
      const sessions = createSessions({
        list,
        deleteMany,
      });
      const { page, changeScope } = await setupArchivedPageWithSelection("writer", sessions);
      const confirmation = createDeferred<boolean>();
      vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);

      const operation = page.deleteAllArchived();
      await vi.waitFor(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
      // Operator switches to `main` while the destructive confirmation sits open.
      changeScope("main");
      if (returnToOriginal) {
        changeScope("writer");
      }
      await page.updateComplete;
      await vi.waitFor(() => expect(page.loading).toBe(false));
      confirmation.resolve(true);
      await operation;

      expect(deleteMany).not.toHaveBeenCalled();
      expect(page.error).toBeNull();
    },
  );

  it.each([false, true])(
    "admits a new delete without letting old completion release it (deep link: %s)",
    async (deepLink) => {
      const oldDelete = createDeferred<Awaited<ReturnType<SessionCapability["deleteMany"]>>>();
      const newDelete = createDeferred<Awaited<ReturnType<SessionCapability["deleteMany"]>>>();
      const deleteMany = vi
        .fn<SessionCapability["deleteMany"]>()
        .mockReturnValueOnce(oldDelete.promise)
        .mockReturnValueOnce(newDelete.promise)
        .mockResolvedValue({ deleted: [], errors: [], preservedWorktrees: [] });
      const sessions = createSessions({ deleteMany });
      const key = "agent:writer:old-1";
      const { page, changeScope } = await setupArchivedPageWithSelection(
        "writer",
        sessions,
        deepLink ? key : null,
      );
      vi.mocked(showConfirmDialog).mockResolvedValue(true);
      const oldRequest = page.deleteSessionFromMenu({ key, kind: "direct", archived: true });
      let newRequest: Promise<void> | undefined;
      try {
        await vi.waitFor(() => expect(deleteMany).toHaveBeenCalledTimes(1));
        expect(page.sessionMutationPending).toBe(true);
        changeScope("main");
        await page.updateComplete;
        await vi.waitFor(() => expect(page.loading).toBe(false));

        const newRow: GatewaySessionRow = {
          key: deepLink ? key : "agent:main:new",
          kind: "direct",
          archived: true,
        };
        newRequest = page.deleteSessionFromMenu(newRow);
        await vi.waitFor(() => expect(deleteMany).toHaveBeenCalledTimes(2));
        expect(deleteMany.mock.calls[1]?.[0]).toEqual([
          { key: newRow.key, agentId: undefined, archivedOnly: true },
        ]);
        expect(page.sessionMutationPending).toBe(true);

        oldDelete.resolve({
          deleted: [],
          errors: ["retired delete error"],
          preservedWorktrees: [],
        });
        await oldRequest;
        expect(page.error).toBeNull();
        expect(page.sessionMutationPending).toBe(true);
        await page.deleteSessionFromMenu(newRow);
        expect(deleteMany).toHaveBeenCalledTimes(2);

        newDelete.resolve({ deleted: [], errors: [], preservedWorktrees: [] });
        await newRequest;
        expect(page.sessionMutationPending).toBe(false);
        await page.deleteSessionFromMenu(newRow);
        expect(deleteMany).toHaveBeenCalledTimes(3);
      } finally {
        oldDelete.resolve({ deleted: [], errors: [], preservedWorktrees: [] });
        newDelete.resolve({ deleted: [], errors: [], preservedWorktrees: [] });
        await Promise.all([oldRequest, newRequest]);
      }
    },
  );

  it.each(["branchCheckpoint", "restoreCheckpoint"] as const)(
    "retires %s authority across A-B-A without clearing newer work",
    async (method) => {
      const oldBranch =
        createDeferred<Awaited<ReturnType<SessionCapability["branchCheckpoint"]>>>();
      const oldRestore = createDeferred<never>();
      const newMutation = createDeferred<never>();
      const branchResult: Awaited<ReturnType<SessionCapability["branchCheckpoint"]>> = {
        ok: true,
        sourceKey: "agent:writer:old-1",
        key: "agent:writer:stale-branch",
        sessionId: "branched-session",
        checkpoint: {
          checkpointId: "checkpoint",
          sessionKey: "agent:writer:old-1",
          sessionId: "original-session",
          createdAt: 1,
          reason: "manual",
          preCompaction: { sessionId: "original-session" },
          postCompaction: { sessionId: "original-session" },
        },
        entry: { sessionId: "branched-session", updatedAt: 1 },
      };
      const mutate =
        method === "branchCheckpoint"
          ? vi
              .fn<SessionCapability["branchCheckpoint"]>()
              .mockReturnValueOnce(oldBranch.promise)
              .mockReturnValueOnce(newMutation.promise)
          : vi
              .fn<SessionCapability["restoreCheckpoint"]>()
              .mockReturnValueOnce(oldRestore.promise)
              .mockReturnValueOnce(newMutation.promise);
      const sessions = createSessions({ [method]: mutate });
      const { page, context, changeScope } = await setupArchivedPageWithSelection(
        "writer",
        sessions,
      );
      vi.mocked(showConfirmDialog).mockResolvedValue(true);
      const oldRequest = page[method]("agent:writer:old-1", "checkpoint");
      let newRequest: Promise<void> | undefined;
      try {
        await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
        expect(page.checkpointBusyKey).toBe("checkpoint");
        changeScope("main");
        expect(page.checkpointBusyKey).toBeNull();
        changeScope("writer");

        newRequest = page[method]("agent:writer:old-1", "checkpoint");
        await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
        if (method === "branchCheckpoint") {
          oldBranch.resolve(branchResult);
        } else {
          oldRestore.reject(new Error("retired checkpoint error"));
        }
        await oldRequest;
        expect(page.error).toBeNull();
        expect(context.navigate).not.toHaveBeenCalled();
        expect(page.checkpointBusyKey).toBe("checkpoint");

        newMutation.reject(new Error("current checkpoint error"));
        await newRequest;
        expect(page.error).toContain("current checkpoint error");
        expect(page.checkpointBusyKey).toBeNull();
      } finally {
        if (method === "branchCheckpoint") {
          oldBranch.resolve(branchResult);
        } else {
          oldRestore.reject(new Error("cleanup old checkpoint"));
        }
        if (newRequest) {
          newMutation.reject(new Error("cleanup new checkpoint"));
        }
        await Promise.all([oldRequest, newRequest]);
      }
    },
  );

  it("preserves pending deletion when the selected scope does not change", async () => {
    const deletion = createDeferred<Awaited<ReturnType<SessionCapability["deleteMany"]>>>();
    const deleteMany = vi
      .fn<SessionCapability["deleteMany"]>()
      .mockReturnValueOnce(deletion.promise)
      .mockResolvedValue({ deleted: [], errors: [], preservedWorktrees: [] });
    const { page, changeScope } = await setupArchivedPageWithSelection(
      "writer",
      createSessions({ deleteMany }),
    );
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const row: GatewaySessionRow = { key: "agent:writer:old-1", kind: "direct", archived: true };
    const request = page.deleteSessionFromMenu(row);
    try {
      await vi.waitFor(() => expect(deleteMany).toHaveBeenCalledTimes(1));
      changeScope("writer");
      await page.deleteSessionFromMenu(row);
      expect(deleteMany).toHaveBeenCalledTimes(1);
      expect(page.sessionMutationPending).toBe(true);
      deletion.resolve({ deleted: [], errors: [], preservedWorktrees: [] });
      await request;
      expect(page.sessionMutationPending).toBe(false);
      await page.deleteSessionFromMenu(row);
      expect(deleteMany).toHaveBeenCalledTimes(2);
    } finally {
      deletion.resolve({ deleted: [], errors: [], preservedWorktrees: [] });
      await request;
    }
  });

  it("keeps a deep-link query and its session-bound checkpoint load across scope changes", async () => {
    const checkpoints = createDeferred<SessionCompactionCheckpoint[]>();
    const listCheckpoints = vi.fn<SessionCapability["listCheckpoints"]>(() => checkpoints.promise);
    const sessions = createSessions({ listCheckpoints });
    const key = "agent:writer:old-1";
    const { page, changeScope } = await setupArchivedPageWithSelection("writer", sessions, key);
    const request = page.loadCheckpoint(key);
    try {
      await vi.waitFor(() => expect(page.checkpointLoadingKey).toBe(key));
      const query = vi.mocked(sessions.subscribeList).mock.calls.at(-1)?.[0];
      expect(query).toMatchObject({ search: key, agentId: "writer" });
      const calls = listCheckpoints.mock.calls.length;
      changeScope("main");
      await page.updateComplete;
      expect(page.checkpointLoadingKey).toBe(key);
      expect(vi.mocked(sessions.subscribeList).mock.calls.at(-1)?.[0]).toEqual(query);
      expect(listCheckpoints).toHaveBeenCalledTimes(calls);
      checkpoints.resolve([]);
      await request;
      expect(page.checkpointItemsByKey[key]).toEqual([]);
      expect(page.checkpointLoadingKey).toBeNull();
    } finally {
      checkpoints.resolve([]);
      await request;
    }
  });

  it("preserves the same-scope all-agent deleteAllArchived path", async () => {
    const writerKeys = ["agent:writer:old-1", "agent:writer:old-2"];
    const list = vi.fn(async () => ({
      count: writerKeys.length,
      totalCount: writerKeys.length,
      sessions: writerKeys.map((key) => ({ key, archived: true })),
      hasMore: false,
      nextOffset: null,
    })) as unknown as SessionCapability["list"];
    const deleteMany = vi.fn(async () => ({
      deleted: writerKeys,
      errors: [],
      preservedWorktrees: [],
    }));
    const sessions = createSessions({
      list,
      deleteMany,
    });
    const { page } = await setupArchivedPageWithSelection(null, sessions);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    await page.deleteAllArchived();

    expect(deleteMany).toHaveBeenCalledOnce();
  });
});
