import { describe, expect, it, vi } from "vitest";
import type { SessionWorkspaceListResult } from "../../../api/types.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
} from "../chat-pane.test-support.ts";
import { getSessionWorkspace, loadSessionWorkspace } from "./chat-session-workspace-state.ts";
import {
  createSessionWorkspaceProps,
  openSessionWorkspaceFile,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";

async function fixture() {
  let resolve!: (value: SessionWorkspaceListResult) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<SessionWorkspaceListResult>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const listing: SessionWorkspaceListResult = {
    sessionKey: "agent:main:current",
    root: "/workspace",
    files: [],
    artifacts: [],
    browser: { path: "", entries: [] },
  };
  const listFiles = vi
    .fn()
    .mockResolvedValueOnce(listing)
    .mockReturnValueOnce(pending)
    .mockResolvedValue(listing);
  const state: SessionWorkspaceHost = {
    client: createGatewayBrowserClientFixture({ request: () => ({ artifacts: [] }) }),
    connected: true,
    connectionEpoch: 1,
    sessionKey: listing.sessionKey,
    hello: null,
    agentsList: { defaultId: "main", mainKey: "main", scope: "global", agents: [] },
    sidebarContent: null,
    handleOpenSidebar: () => {},
    sessions: createSessionCapabilityFixture({
      listFiles,
      getFile: async () => ({
        sessionKey: listing.sessionKey,
        root: "/workspace",
        file: {
          path: "reports/inventory.csv",
          workspacePath: "reports/inventory.csv",
          name: "inventory.csv",
          kind: "read",
          missing: false,
          previewKind: "text",
          contentEncoding: "utf8",
          content: "item,count\nnotebooks,3",
        },
      }),
    }),
  };
  const props = () => createSessionWorkspaceProps(state);
  const settled = () => vi.waitFor(() => expect(props().loading).toBe(false));
  const reload = () => loadSessionWorkspace(state, getSessionWorkspace(state), true);
  const openFile = async () => {
    openSessionWorkspaceFile(state, { path: "reports/inventory.csv" });
    await vi.waitFor(() =>
      expect(state.sessionWorkspaceState?.previews[0]?.content.kind).toBe("file"),
    );
  };
  createSessionWorkspaceProps(state, { expanded: true });
  await settled();
  const finish = (outcome: "success" | "failure") =>
    outcome === "success" ? resolve(listing) : reject(new Error("old listing unavailable"));
  return { state, listing, listFiles, resolve, finish, props, settled, reload, openFile };
}

describe("workspace listing ownership", () => {
  it.each(["success", "failure"] as const)(
    "ignores an old directory %s after browsing elsewhere",
    async (outcome) => {
      const { state, listFiles, finish, props, settled, reload } = await fixture();
      reload();
      props().onBrowsePath("reports");
      finish(outcome);
      await settled();
      expect(props()).toMatchObject({ error: null, list: null });
      createSessionWorkspaceProps(state, { expanded: true });
      await vi.waitFor(() => expect(listFiles).toHaveBeenCalledTimes(3));
      expect(listFiles).toHaveBeenLastCalledWith(state.sessionKey, {
        path: "reports",
        search: "",
        agentId: "main",
      });
    },
  );

  it.each(["success", "failure"] as const)(
    "ignores an old search %s without bypassing debounce",
    async (outcome) => {
      const { state, listFiles, finish, props, reload } = await fixture();
      vi.useFakeTimers();
      try {
        reload();
        props().onSearch("inventory");
        finish(outcome);
        await vi.advanceTimersByTimeAsync(0);
        expect(createSessionWorkspaceProps(state, { expanded: true })).toMatchObject({
          loading: false,
          error: null,
          list: null,
        });
        expect(listFiles).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(159);
        expect(listFiles).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(listFiles).toHaveBeenCalledTimes(3);
        expect(listFiles).toHaveBeenLastCalledWith(state.sessionKey, {
          path: "",
          search: "inventory",
          agentId: "main",
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    "preserves file intent across missing rows (reopen: %s)",
    async (reopen) => {
      const { listing, listFiles, resolve, props, settled, reload, openFile } = await fixture();
      if (reopen) {
        await openFile();
      }
      reload();
      await openFile();
      const selected = props().activeId;
      expect(selected).toBeTruthy();
      resolve(listing);
      await settled();
      expect(props().activeId).toBe(selected);

      reload();
      await settled();
      expect(props().activeId).toBe(selected);
      listFiles.mockResolvedValue({
        ...listing,
        browser: {
          path: "reports",
          entries: [{ kind: "file", name: "inventory.csv", path: "reports/inventory.csv" }],
        },
      });
      props().onBrowsePath("reports");
      await settled();
      expect(props().activeId).toBe(selected);
      expect(props().list?.browser?.entries[0]?.path).toBe("reports/inventory.csv");
    },
  );
});
