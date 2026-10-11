/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import type { SessionDeleteTarget } from "../../lib/sessions/session-capability.ts";
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
    sessionsResult([{ key: "agent:writer:old-1", kind: "direct", archived: true }], 1),
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

  it("retires pending enumeration after switching away and back", async () => {
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
    changeScope("writer");
    listResponse.resolve({
      ...sessionsResult(
        writerKeys.map((key) => ({ key, kind: "direct", updatedAt: 1, archived: true })),
        1,
      ),
      totalCount: writerKeys.length,
    });
    await operation;

    expect(showConfirmDialog).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(page.error).toBeNull();
  });

  it("retires pending confirmation after switching away and back", async () => {
    const writerKeys = ["agent:writer:old-1", "agent:writer:old-2"];
    const list = vi.fn<SessionCapability["list"]>(async () => ({
      ...sessionsResult(
        writerKeys.map((key) => ({ key, kind: "direct", archived: true })),
        1,
      ),
      totalCount: writerKeys.length,
      hasMore: false,
      nextOffset: null,
    }));
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
    changeScope("writer");
    await page.updateComplete;
    await vi.waitFor(() => expect(page.loading).toBe(false));
    confirmation.resolve(true);
    await operation;

    expect(deleteMany).not.toHaveBeenCalled();
    expect(page.error).toBeNull();
  });

  it("admits a new deep-link delete without letting old completion release it", async () => {
    const oldDelete = createDeferred<Awaited<ReturnType<SessionCapability["deleteMany"]>>>();
    const newDelete = createDeferred<Awaited<ReturnType<SessionCapability["deleteMany"]>>>();
    const deleteMany = vi
      .fn<SessionCapability["deleteMany"]>()
      .mockReturnValueOnce(oldDelete.promise)
      .mockReturnValueOnce(newDelete.promise)
      .mockResolvedValue({ deleted: [], errors: [], preservedWorktrees: [] });
    const sessions = createSessions({ deleteMany });
    const key = "agent:writer:old-1";
    const { page, changeScope } = await setupArchivedPageWithSelection("writer", sessions, key);
    const query = vi.mocked(sessions.subscribeList).mock.calls.at(-1)?.[0];
    expect(query).toMatchObject({ search: key, agentId: "writer" });
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const oldRequest = page.deleteSessionFromMenu({ key, kind: "direct", archived: true });
    let newRequest: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(deleteMany).toHaveBeenCalledTimes(1));
      expect(page.sessionMutationPending).toBe(true);
      changeScope("main");
      await page.updateComplete;
      await vi.waitFor(() => expect(page.loading).toBe(false));
      expect(vi.mocked(sessions.subscribeList).mock.calls.at(-1)?.[0]).toEqual(query);

      const newRow: GatewaySessionRow = {
        key,
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
        errors: [{ target: { key }, error: new Error("retired delete error") }],
        preservedWorktrees: [],
      });
      await oldRequest;
      expect(page.error).toBeNull();
      expect(page.sessionMutationPending).toBe(true);
      changeScope("main");
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
  });
});

describe("session selection across roster refresh", () => {
  it.each(["replaced", "replacement without IDs during confirmation", "removed"] as const)(
    "deletes only still-selected session identities after a row is %s",
    async (change) => {
      const missingIds = change.startsWith("replacement without IDs");
      const duringConfirmation = change === "replacement without IDs during confirmation";
      const confirmation = createDeferred<boolean>();
      const rows: GatewaySessionRow[] = Array.from({ length: 27 }, (_, index) => ({
        key: `agent:main:selection-${index}`,
        sessionId: index === 0 && missingIds ? undefined : `selected-generation-${index}`,
        kind: "direct",
        updatedAt: 100 - index,
      }));
      const original = rows[0]!;
      const stable = rows[1]!;
      let serverRows = rows;
      let revision = 0;
      const deletedStable = createDeferred();
      const deletedTargets: SessionDeleteTarget[] = [];
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        if (method === "sessions.list") {
          return sessionsResult(
            serverRows.filter((row) => !row.archived),
            ++revision,
          );
        }
        if (method === "sessions.delete") {
          const target = params as SessionDeleteTarget;
          deletedTargets.push(target);
          serverRows = serverRows.filter((row) => row.key !== target.key);
          if (target.key === stable.key) {
            deletedStable.resolve();
          }
          return { deleted: true };
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const { gateway } = createGateway({ request } as unknown as GatewayBrowserClient);
      const sessions = createTestSessionCapability(gateway);
      const subscribe = vi.spyOn(sessions, "subscribeList");
      const deletion = vi.spyOn(sessions, "deleteMany");
      const page = await createRenderedPage(
        createContext(gateway, sessions),
        sessionsResult(rows, revision),
      );
      const pageSize = page.querySelector<HTMLSelectElement>(".data-table-pagination__size");
      expect(pageSize?.getAttribute("aria-label")).toBe("Rows per page");
      expect(pageSize?.value).toBe("25");
      expect(pageSize?.selectedOptions[0]?.textContent?.trim()).toBe("25 per page");
      const button = (label: string) => {
        const match = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
          (entry) => entry.textContent?.trim() === label,
        );
        if (!match) {
          throw new Error(`Missing rendered button: ${label}`);
        }
        return match;
      };
      try {
        for (const row of [original, stable]) {
          const checkbox = page.querySelector<HTMLInputElement>(
            `input[aria-label="Select session: ${row.key}"]`,
          );
          expect(checkbox).not.toBeNull();
          checkbox!.click();
          await page.updateComplete;
        }
        expect(page.querySelector(".data-table-bulk-bar")?.textContent).toContain("2 selected");
        button("Next").click();
        await page.updateComplete;
        expect(
          page.querySelector(`input[aria-label="Select session: ${original.key}"]`),
        ).toBeNull();
        expect(page.querySelector(".data-table-bulk-bar")?.textContent).toContain("2 selected");

        vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
        if (duringConfirmation) {
          button("Delete").click();
          expect(showConfirmDialog).toHaveBeenCalledOnce();
        }
        if (change === "removed") {
          serverRows = rows.slice(1);
        } else if (change === "replaced" || missingIds) {
          serverRows = [
            {
              ...original,
              label: "Replacement session",
              sessionId: missingIds ? undefined : "replacement-generation",
            },
            ...rows.slice(1),
          ];
        }
        await sessions.refreshList({ ...subscribe.mock.calls[0]![0], force: true });
        await page.updateComplete;
        if (!duringConfirmation) {
          button("Delete").click();
        }
        confirmation.resolve(true);
        await deletedStable.promise;
        const outcome = await deletion.mock.results[0]!.value;
        const expectedRows = [stable];
        expect(outcome.errors).toEqual([]);
        expect(outcome.deleted).toEqual(expectedRows.map((row) => row.key));
        expect(serverRows.some((row) => row.key === stable.key)).toBe(false);
        if (change === "replaced" || missingIds) {
          expect(serverRows.find((row) => row.key === original.key)?.label).toBe(
            "Replacement session",
          );
        }

        expect(
          deletedTargets.map(({ key, expectedSessionId }) => ({ key, expectedSessionId })),
        ).toEqual(
          expectedRows.map((row) => ({
            key: row.key,
            expectedSessionId: row.sessionId,
          })),
        );
      } finally {
        page.remove();
        sessions.dispose();
      }
    },
  );
});
