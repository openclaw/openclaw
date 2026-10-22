/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import type { SessionDeleteTarget } from "../../lib/sessions/session-capability.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  getRenderedModalDialog,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import { selectMenuValue, settleSessionMenu } from "../../test-helpers/session-menu.ts";
import {
  createContext,
  createGateway,
  createRenderedPage,
  createSessions,
  withNotifyingAgentSelection,
} from "./sessions-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
});

async function setupArchivedPageWithSelection(
  scopeId: string | null,
  sessions: SessionCapability,
  expandedSessionKey: string | null = null,
) {
  const { gateway } = createGateway({} as GatewayBrowserClient);
  const baseContext = createContext(gateway, sessions);
  const { context, changeScope } = withNotifyingAgentSelection(baseContext, scopeId);
  const page = await createRenderedPage(
    context,
    sessionsResult([archivedRow("agent:writer:old-1")], 1),
    "archived",
    expandedSessionKey,
  );
  return { page, context, changeScope };
}

const writerKeys = ["agent:writer:old-1", "agent:writer:old-2"];
const archivedRow = (key: string): GatewaySessionRow => ({ key, kind: "direct", archived: true });
const deleted = (keys: string[] = []) => ({ deleted: keys, errors: [], preservedWorktrees: [] });
const archivedWriterRows = (updatedAt?: number) => ({
  ...sessionsResult(
    writerKeys.map((key) => ({ key, kind: "direct", archived: true, updatedAt })),
    1,
  ),
  totalCount: writerKeys.length,
});

describe("sessions page agent-scope retirement", () => {
  it.each([false, true])("settles real delete-all confirmation (retire: %s)", async (retire) => {
    const actual = await vi.importActual<typeof import("../../components/confirm-dialog.ts")>(
      "../../components/confirm-dialog.ts",
    );
    vi.mocked(showConfirmDialog).mockImplementation(actual.showConfirmDialog);
    const fixture = createModalDialogTestFixture();
    const list = vi.fn<SessionCapability["list"]>(async (options) =>
      sessionsResult([archivedRow(`agent:${options?.agentId ?? "main"}:archived`)], 1),
    );
    const deleteMany = vi.fn<SessionCapability["deleteMany"]>().mockResolvedValue(deleted());
    try {
      const { page, changeScope } = await setupArchivedPageWithSelection(
        "writer",
        createSessions({ list, deleteMany }),
      );
      let operation = fixture.track(page.deleteAllArchived());
      let actions = await waitForConfirmDialogActions();
      expect((await getRenderedModalDialog(document.body)).dialog.open).toBe(true);

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
        expect((await getRenderedModalDialog(document.body)).dialog.open).toBe(true);
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

  it.each([
    [false, true],
    [true, true],
    [true, false],
  ])(
    "keeps placement outcomes in their captured agent scope (retired=%s, fails=%s)",
    async (retired, fails) => {
      const row: GatewaySessionRow = {
        key: "global",
        agentId: "writer",
        sessionId: "writer-global",
        kind: "direct",
        placement: {
          state: "draining",
          generation: 2,
          createdAtMs: 1,
          updatedAtMs: 2,
          stateChangedAtMs: 2,
          environmentId: "worker:writer",
          activeOwnerEpoch: 7,
          workerBundleHash: "a".repeat(64),
          workspaceBaseManifestRef: "base",
          remoteWorkspaceDir: "/workspace",
        },
        placementMove: {
          target: { kind: "gateway" },
          updatedAtMs: 2,
          error: "Sync failed",
          retry: {
            expected: { generation: 1, environmentId: "worker:writer", ownerEpoch: 7 },
            target: { kind: "gateway" },
          },
        },
      };
      const pending = createDeferred<unknown>();
      const request = vi.fn(async (method: string) =>
        method === "sessions.move" ? pending.promise : { profiles: [] },
      );
      const client = createTestGatewayClient(request);
      const clientRequest = vi.spyOn(client, "request");
      const connection = createGateway(client);
      connection.emit({
        hello: gatewayHelloForMethods(["sessions.move"], ["operator.read", "operator.write"]),
      });
      const reconcileMutation = vi
        .fn<SessionCapability["reconcileMutation"]>()
        .mockResolvedValue({ status: "refreshed" });
      const sessions = createSessions({ reconcileMutation });
      const { context, changeScope } = withNotifyingAgentSelection(
        createContext(connection.gateway, sessions),
        "writer",
      );
      const page = await createRenderedPage(context, sessionsResult([row], 1));
      await vi.waitFor(() => expect(page.loading).toBe(false));
      page.openSessionMenu(row, { x: 10, y: 20 }, document.createElement("button"));
      await page.updateComplete;
      const menu = page.querySelector("openclaw-session-menu")!;
      await settleSessionMenu(menu);
      await selectMenuValue(menu, "move-session");
      await vi.waitFor(() =>
        expect(clientRequest).toHaveBeenCalledWith("sessions.move", {
          key: "global",
          agentId: "writer",
          ...row.placementMove!.retry,
        }),
      );
      const moveIndex = clientRequest.mock.calls.findIndex(
        ([method]) => method === "sessions.move",
      );
      const result = clientRequest.mock.results[moveIndex]!.value;
      if (retired) {
        changeScope("main");
        changeScope("writer");
        await page.updateComplete;
        await vi.waitFor(() => expect(page.loading).toBe(false));
        page.error = "New foreground error.";
      }
      const failure = new Error("Old placement failed.");
      if (fails) {
        pending.reject(failure);
      } else {
        pending.resolve({ ok: true });
      }
      await Promise.resolve(result).catch(() => undefined);
      await page.updateComplete;
      if (retired) {
        expect(reconcileMutation).not.toHaveBeenCalled();
        expect(page.textContent).toContain("New foreground error.");
        expect(page.textContent).not.toContain("Old placement failed.");
      } else {
        await vi.waitFor(() => expect(page.error).toBe(failure));
        expect(reconcileMutation).toHaveBeenCalledWith("writer");
      }
    },
  );

  it.each(["enumeration", "confirmation"])(
    "retires pending %s after switching away and back",
    async (phase) => {
      const listResponse = createDeferred<SessionsListResult>();
      const confirmation = createDeferred<boolean>();
      const list = vi.fn<SessionCapability["list"]>().mockReturnValue(listResponse.promise);
      const deleteMany = vi.fn(async () => deleted(writerKeys));
      const sessions = createSessions({ list, deleteMany });
      const { page, changeScope } = await setupArchivedPageWithSelection("writer", sessions);
      vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
      if (phase === "confirmation") {
        listResponse.resolve({ ...archivedWriterRows(), hasMore: false, nextOffset: null });
      }
      const operation = page.deleteAllArchived();
      await vi.waitFor(() =>
        expect(phase === "enumeration" ? list : showConfirmDialog).toHaveBeenCalledOnce(),
      );
      changeScope("main");
      changeScope("writer");
      if (phase === "confirmation") {
        await page.updateComplete;
        await vi.waitFor(() => expect(page.loading).toBe(false));
      }
      listResponse.resolve(archivedWriterRows(1));
      confirmation.resolve(true);
      await operation;
      if (phase === "enumeration") {
        expect(showConfirmDialog).not.toHaveBeenCalled();
      }
      expect(deleteMany).not.toHaveBeenCalled();
      expect(page.error).toBeNull();
    },
  );

  it("admits a new deep-link delete without letting old completion release it", async () => {
    const oldDelete = createDeferred<Awaited<ReturnType<SessionCapability["deleteMany"]>>>();
    const newDelete = createDeferred<Awaited<ReturnType<SessionCapability["deleteMany"]>>>();
    const deleteMany = vi
      .fn<SessionCapability["deleteMany"]>()
      .mockReturnValueOnce(oldDelete.promise)
      .mockReturnValueOnce(newDelete.promise)
      .mockResolvedValue(deleted());
    const sessions = createSessions({ deleteMany });
    const key = "agent:writer:old-1";
    const { page, changeScope } = await setupArchivedPageWithSelection("writer", sessions, key);
    const query = vi.mocked(sessions.subscribeList).mock.calls.at(-1)?.[0];
    expect(query).toMatchObject({ search: key, agentId: "writer" });
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const oldRequest = page.deleteSessionFromMenu(archivedRow(key));
    let newRequest: ReturnType<typeof page.deleteSessionFromMenu> | undefined;
    try {
      await vi.waitFor(() => expect(deleteMany).toHaveBeenCalledTimes(1));
      changeScope("main");
      await page.updateComplete;
      await vi.waitFor(() => expect(page.loading).toBe(false));
      expect(vi.mocked(sessions.subscribeList).mock.calls.at(-1)?.[0]).toEqual(query);

      const newRow = archivedRow(key);
      newRequest = page.deleteSessionFromMenu(newRow);
      await vi.waitFor(() => expect(deleteMany).toHaveBeenCalledTimes(2));
      expect(deleteMany.mock.calls[1]?.[0]).toEqual([
        { key: newRow.key, agentId: undefined, archivedOnly: true },
      ]);

      oldDelete.resolve({
        ...deleted(),
        errors: [{ target: { key }, error: new Error("retired delete error") }],
      });
      await oldRequest;
      expect(page.error).toBeNull();
      changeScope("main");
      await page.deleteSessionFromMenu(newRow);
      expect(deleteMany).toHaveBeenCalledTimes(2);

      newDelete.resolve(deleted());
      await newRequest;
      await page.deleteSessionFromMenu(newRow);
      expect(deleteMany).toHaveBeenCalledTimes(3);
    } finally {
      oldDelete.resolve(deleted());
      newDelete.resolve(deleted());
      await Promise.all([oldRequest, newRequest]);
    }
  });
});

describe("session selection across roster refresh", () => {
  it.each(["replaced", "replacement without IDs during confirmation", "removed"] as const)(
    "deletes only still-selected session identities after a row is %s",
    async (change) => {
      const missingIds = change === "replacement without IDs during confirmation";
      const confirmation = createDeferred<boolean>();
      const rows: GatewaySessionRow[] = Array.from({ length: 27 }, (_, index) => ({
        key: `agent:main:selection-${index}`,
        sessionId: index === 0 && missingIds ? undefined : `selected-generation-${index}`,
        kind: "direct",
        updatedAt: 100 - index,
      }));
      const [original, stable] = [rows[0]!, rows[1]!];
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
      const button = (label: string) =>
        [...page.querySelectorAll<HTMLButtonElement>("button")].find(
          (entry) => entry.textContent?.trim() === label,
        )!;
      const checkbox = (key: string) =>
        page.querySelector<HTMLInputElement>(`input[aria-label="Select session: ${key}"]`);
      try {
        for (const row of [original, stable]) {
          expect(checkbox(row.key)).not.toBeNull();
          checkbox(row.key)!.click();
          await page.updateComplete;
        }
        expect(page.querySelector(".data-table-bulk-bar")?.textContent).toContain("2 selected");
        button("Next").click();
        await page.updateComplete;
        expect(checkbox(original.key)).toBeNull();
        expect(page.querySelector(".data-table-bulk-bar")?.textContent).toContain("2 selected");

        vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
        if (missingIds) {
          button("Delete").click();
          expect(showConfirmDialog).toHaveBeenCalledOnce();
        }
        if (change === "removed") {
          serverRows = rows.slice(1);
        } else {
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
        if (!missingIds) {
          button("Delete").click();
        }
        confirmation.resolve(true);
        await deletedStable.promise;
        const { errors, deleted: removed } = await deletion.mock.results[0]!.value;
        expect([errors, removed]).toEqual([[], [stable.key]]);
        expect(serverRows.some((row) => row.key === stable.key)).toBe(false);
        if (change !== "removed") {
          expect(serverRows.find((row) => row.key === original.key)?.label).toBe(
            "Replacement session",
          );
        }

        expect(deletedTargets).toMatchObject([
          { key: stable.key, expectedSessionId: stable.sessionId },
        ]);
      } finally {
        page.remove();
        sessions.dispose();
      }
    },
  );
});
