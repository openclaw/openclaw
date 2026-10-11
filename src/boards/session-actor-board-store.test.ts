import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionActorAuthority } from "../config/sessions/session-actor-contract.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { acquireSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { BoardValidationError } from "./board-layout.js";
import { SqliteBoardStore } from "./sqlite-board-store.js";

const sessionKey = "agent:main:dashboard:incognito-board";
const target = { sessionKey };
const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory Board opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory Board allocated a worker");
  }),
}));

const env = { OPENCLAW_STATE_DIR: "/synthetic/memory-boards" };
const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
afterEach(() => memorySessionActorOwners.reset());

function storeForSession() {
  return new SqliteBoardStore({
    resolveSession: () => ({ agentId: "main", path: storePath, sessionKey }),
    env,
  });
}

async function withStore(run: (store: SqliteBoardStore) => Promise<void>) {
  const binding = (await acquireSessionActorStorage(
    { agentId: "main", storePath, sessionKey, env },
    { authority, lifetime: { assertCurrent() {}, assertReadable() {} }, create: true },
  ))!;
  expect(
    (
      await binding.actor.storage.mutate(
        {
          type: "session.entry.create",
          input: { entry: { sessionId: "window-1", updatedAt: 1, incognito: true } },
        },
        authority,
      )
    ).kind,
  ).toBe("committed");
  await binding.actor.release();
  return run(storeForSession());
}

const html = (name: string, body = "<p>hello</p>") => ({
  ...target,
  name,
  content: { kind: "html" as const, html: body },
});
const app = (serverName = "server") => ({
  ...target,
  name: "app",
  content: {
    kind: "mcp-app" as const,
    interactive: true,
    descriptor: { serverName, toolName: "tool", uiResourceUri: "ui://app", toolCallId: "call" },
  },
  declared: { tools: ["tool"] },
});

describe("session actor BoardStore", () => {
  it("reads absent sessions without creating them and rejects writes", async () => {
    const store = storeForSession();
    expect(await store.getSnapshot(target)).toEqual({
      sessionKey,
      revision: 0,
      tabs: [],
      widgets: [],
    });
    expect(await store.useWidgetDocument(target, "missing", (value) => value)).toBeUndefined();
    expect(await store.applyOps(target, [])).toEqual({
      sessionKey,
      revision: 0,
      tabs: [],
      widgets: [],
    });
    await expect(store.putWidget(html("missing"))).rejects.toMatchObject({ code: "not_found" });
    expect(memorySessionActorOwners.list()).toEqual([]);
  });

  it("serializes writes without lost widgets and consumes detached reads outside the FIFO", () =>
    withStore(async (store) => {
      const first = store.putWidget(html("one"));
      const second = store.putWidget(html("two"));
      const read = store.getSnapshot(target);
      await Promise.all([first, second]);
      const snapshot = await read;
      expect(snapshot.revision).toBe(2);
      expect(snapshot.widgets.map((widget) => widget.name)).toEqual(["one", "two"]);
      snapshot.widgets[0]!.title = "caller mutation";
      const moved = await store.useSnapshot(target, () =>
        store.applyOps(target, [{ kind: "widget_resize", name: "one", sizeW: 2, sizeH: 3 }]),
      );
      expect(moved.widgets[0]).toMatchObject({ sizeW: 2, sizeH: 3, heightMode: "fixed" });
      expect(moved.widgets[0]!.title).toBeUndefined();
      await expect(
        store.applyOps(target, [
          { kind: "widget_remove", name: "one" },
          { kind: "widget_remove", name: "missing" },
        ]),
      ).rejects.toBeInstanceOf(BoardValidationError);
      expect(await store.getSnapshot(target)).toEqual(moved);
    }));

  it("keeps byte-frozen grants, generated identity and document metadata in one state", () =>
    withStore(async (store) => {
      await store.putWidget(html("chart"));
      const input = {
        ...html("chart"),
        generatedIdentity: {
          source: "show_widget" as const,
          key: "a".repeat(64),
          fallbackName: "chart-generated",
        },
        declared: { netOrigins: ["https://example.com", "https://other.example"] },
      };
      const created = await store.putWidget(input);
      expect(created.resolvedWidgetName).toBe("chart-generated");
      const widget = created.widgets.find((item) => item.name === "chart-generated")!;
      await expect(
        store.grant(target, widget.name, "granted", widget.revision, "old-instance"),
      ).rejects.toMatchObject({ code: "conflict" });
      await store.grant(target, widget.name, "granted", widget.revision, widget.instanceId);
      const narrowed = await store.putWidget({
        ...input,
        name: "new-preference",
        declared: { netOrigins: ["https://example.com"] },
      });
      expect(narrowed.resolvedWidgetName).toBe(widget.name);
      expect(narrowed.widgets[1]!.grantState).toBe("granted");
      const metadata = await store.getSnapshotWithHtmlViewMetadata(target);
      const document = await store.useWidgetDocument(target, widget.name, (value) => value);
      expect(document).toEqual({
        ...metadata.htmlViewMetadata.get(widget.name),
        html: "<p>hello</p>",
      });
      await store.putWidget({ ...input, content: { kind: "html", html: "<p>changed</p>" } });
      expect(await store.useWidgetDocument(target, widget.name, (value) => value)).toMatchObject({
        html: "<p>changed</p>",
        grantState: "pending",
        revision: 3,
      });
      await expect(
        store.grant(target, widget.name, "granted", 1, widget.instanceId),
      ).rejects.toMatchObject({ code: "conflict" });
      await store.applyOps(target, [{ kind: "widget_remove", name: widget.name }]);
      expect(await store.useWidgetDocument(target, widget.name, (value) => value)).toBeUndefined();
    }));

  it("prepares MCP interaction outside the FIFO and checks source permission at the write", () =>
    withStore(async (store) => {
      const first = await store.putWidget(app(), {
        resolveMcpAppInteraction: async () => {
          await store.putWidget(html("prepared"));
          return true;
        },
      });
      const widget = first.widgets.find((item) => item.name === "app")!;
      await store.grant(target, "app", "granted", widget.revision, widget.instanceId);
      await store.putWidget(app("other-server"));
      expect(await store.readWidgetMcpApp(target, "app")).toMatchObject({
        grantState: "pending",
        descriptor: { serverName: "other-server" },
      });
      const noninteractive = await store.putWidget(app(), {
        resolveMcpAppInteraction: async () => false,
      });
      expect(noninteractive.widgets.find((item) => item.name === "app")!.grantState).toBe("none");
      expect(await store.readWidgetMcpApp(target, "app")).toMatchObject({
        interactive: false,
        declaredTools: [],
      });
      let allowed = true;
      await expect(
        store.putWidget(app(), {
          resolveMcpAppInteraction: async () => {
            allowed = false;
            return true;
          },
          assertCurrent() {
            if (!allowed) {
              throw new Error("Source permission revoked");
            }
          },
        }),
      ).rejects.toThrow("Source permission revoked");
      expect(await store.getSnapshot(target)).toMatchObject({
        revision: noninteractive.revision,
        widgets: noninteractive.widgets,
      });
    }));

  it("retains registered documents and plugin instances, and resets an empty board revision", () =>
    withStore(async (store) => {
      const registered = await store.putWidget({
        ...target,
        name: "report",
        title: "Report",
        content: {
          kind: "registered",
          pluginKind: "example:chart",
          contentKind: "chart",
          source: "named source",
        },
      });
      expect(await store.useWidgetDocument(target, "report", (value) => value)).toMatchObject({
        pluginKind: "example:chart",
        source: "named source",
        title: "Report",
        revision: 1,
        viewGeneration: registered.widgets[0]!.instanceId,
      });
      const plugin = await store.putWidget({
        ...target,
        name: "plugin",
        content: { kind: "plugin", pluginKind: "example", props: { count: 1 } },
      });
      const updated = await store.putWidget({
        ...target,
        name: "plugin",
        content: { kind: "plugin", pluginKind: "example", props: { count: 2 } },
      });
      expect(updated.widgets[1]!.instanceId).toBe(plugin.widgets[1]!.instanceId);
      expect(updated.widgets[1]!.props).toEqual({ count: 2 });
      await store.applyOps(target, [
        { kind: "widget_remove", name: "report" },
        { kind: "widget_remove", name: "plugin" },
        { kind: "tab_delete", tabId: "main" },
      ]);
      expect(await store.getSnapshot(target)).toEqual({
        sessionKey,
        revision: 0,
        tabs: [],
        widgets: [],
      });
    }));
});
