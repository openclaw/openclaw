import { describe, expect, it, vi } from "vitest";
import type { SessionWorkspaceListResult } from "../../../api/types.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
} from "../chat-pane.test-support.ts";
import {
  createSessionWorkspaceProps,
  openSessionWorkspaceFile,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";

function fixture() {
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
    requestUpdate: vi.fn(),
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
          content: "item,count\nnotebooks,3",
        },
      }),
    }),
  };
  return { state, listing, listFiles, resolve, reject };
}

describe("workspace listing ownership", () => {
  it.each(["success", "failure"] as const)(
    "ignores an old directory %s after browsing elsewhere",
    async (outcome) => {
      const { state, listing, listFiles, resolve, reject } = fixture();
      createSessionWorkspaceProps(state, { expanded: true });
      await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
      const props = createSessionWorkspaceProps(state);
      props.onRefresh();
      props.onBrowsePath("reports");
      if (outcome === "success") {
        resolve(listing);
      } else {
        reject(new Error("old directory unavailable"));
      }
      await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
      expect(createSessionWorkspaceProps(state).error).toBeNull();
      expect(createSessionWorkspaceProps(state).list).toBeNull();
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
      const { state, listing, listFiles, resolve, reject } = fixture();
      createSessionWorkspaceProps(state, { expanded: true });
      await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
      vi.useFakeTimers();
      try {
        const props = createSessionWorkspaceProps(state);
        props.onRefresh();
        props.onSearch("inventory");
        if (outcome === "success") {
          resolve(listing);
        } else {
          reject(new Error("old search unavailable"));
        }
        await vi.advanceTimersByTimeAsync(0);
        const settled = createSessionWorkspaceProps(state, { expanded: true });
        expect(settled.loading).toBe(false);
        expect(settled.error).toBeNull();
        expect(settled.list).toBeNull();
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
      const { state, listing, listFiles, resolve } = fixture();
      createSessionWorkspaceProps(state, { expanded: true });
      await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
      if (reopen) {
        openSessionWorkspaceFile(state, { path: "reports/inventory.csv" });
        await vi.waitFor(() =>
          expect(state.sessionWorkspaceState?.previews[0]?.content.kind).toBe("file"),
        );
      }
      createSessionWorkspaceProps(state).onRefresh();
      openSessionWorkspaceFile(state, { path: "reports/inventory.csv" });
      await vi.waitFor(() =>
        expect(state.sessionWorkspaceState?.previews[0]?.content.kind).toBe("file"),
      );
      const selected = createSessionWorkspaceProps(state).activeId;
      expect(selected).toBeTruthy();
      resolve(listing);
      await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
      expect(createSessionWorkspaceProps(state).activeId).toBe(selected);

      createSessionWorkspaceProps(state).onRefresh();
      await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
      expect(createSessionWorkspaceProps(state).activeId).toBe(selected);
      listFiles.mockResolvedValue({
        ...listing,
        browser: {
          path: "reports",
          entries: [{ kind: "file", name: "inventory.csv", path: "reports/inventory.csv" }],
        },
      });
      createSessionWorkspaceProps(state).onBrowsePath("reports");
      await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
      expect(createSessionWorkspaceProps(state).activeId).toBe(selected);
      expect(createSessionWorkspaceProps(state).list?.browser?.entries[0]?.path).toBe(
        "reports/inventory.csv",
      );
    },
  );
});
