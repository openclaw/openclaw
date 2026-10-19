import { afterEach, expect, it, vi } from "vitest";
import type { SessionActorAuthority } from "../config/sessions/session-actor-contract.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { failSessionActorMemoryPublication } from "../config/sessions/session-actor-memory-publication.test-support.js";
import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
} from "../config/sessions/session-actor-storage-binding.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { BoardValidationError } from "./board-layout.js";
import { boardClient, htmlWidget, mcpContent } from "./board-store.fixtures.test-support.js";
import { SqliteBoardStore } from "./sqlite-board-store.js";

const sessionKey = "agent:main:dashboard:incognito-board";
const target = { sessionKey };
const empty = { sessionKey, revision: 0, tabs: [], widgets: [] };
const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
function rejectPersistentResource() {
  throw new Error("Memory Board allocated persistent storage");
}

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(rejectPersistentResource),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(rejectPersistentResource),
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

async function withStore(run: (client: ReturnType<typeof boardClient>) => Promise<void>) {
  const binding = (await bindingForSession(true))!;
  const outcome = await binding.actor.storage.mutate(
    {
      type: "session.entry.create",
      input: { entry: { sessionId: "window-1", updatedAt: 1, incognito: true } },
    },
    authority,
  );
  expect(outcome.kind).toBe("committed");
  await binding.actor.release();
  return run(boardClient(storeForSession(), target));
}

const bindingForSession = (create?: true) =>
  acquireSessionActorStorage(
    { agentId: "main", storePath, sessionKey, env },
    { authority, lifetime, create },
  );
const html = (name: string, body = "<p>hello</p>") => htmlWidget(sessionKey, name, body);
const app = (serverName = "server") => ({
  ...target,
  name: "app",
  content: mcpContent({ serverName }),
  declared: { tools: ["tool"] },
});

it("inherits the memory owner's state root after async preparation", () =>
  withStore(async () => {
    const binding = (await bindingForSession())!;
    try {
      await runWithSessionActorStorage(binding, async () => {
        const store = new SqliteBoardStore({
          resolveSession: async () => ({ agentId: "main", sessionKey }),
        });
        await store.putWidget(html("inherited"));
        expect(await store.getSnapshot(target)).toMatchObject({
          revision: 1,
          widgets: [{ name: "inherited" }],
        });
      });
    } finally {
      await binding.actor.release();
    }
  }));

it("retains the committed widget after publication failure", () =>
  withStore(async ({ store, snapshot }) => {
    const stop = failSessionActorMemoryPublication(sessionKey);
    try {
      await expect(store.putWidget(html("saved"))).rejects.toMatchObject({
        name: "SessionActorStorageCommittedError",
      });
    } finally {
      stop();
    }
    expect(await snapshot()).toMatchObject({ revision: 1, widgets: [{ name: "saved" }] });
  }));

it("reads absent sessions without creating them and rejects writes", async () => {
  const store = storeForSession();
  expect(await store.getSnapshot(target)).toEqual(empty);
  expect(await store.useWidgetDocument(target, "missing", (value) => value)).toBeUndefined();
  expect(await store.applyOps(target, [])).toEqual(empty);
  await expect(store.putWidget(html("missing"))).rejects.toMatchObject({ code: "not_found" });
  expect(memorySessionActorOwners.list()).toEqual([]);
});

it("serializes writes and consumes detached reads outside the FIFO", () =>
  withStore(async ({ store, snapshot, ops }) => {
    const first = store.putWidget(html("one"));
    const second = store.putWidget(html("two"));
    const read = snapshot();
    await Promise.all([first, second]);
    const detached = await read;
    expect(detached).toMatchObject({ revision: 2, widgets: [{ name: "one" }, { name: "two" }] });
    detached.widgets[0]!.title = "caller mutation";
    const moved = await store.useSnapshot(target, () =>
      ops({ kind: "widget_resize", name: "one", sizeW: 2, sizeH: 3 }),
    );
    expect(moved.widgets[0]).toMatchObject({ sizeW: 2, sizeH: 3, heightMode: "fixed" });
    expect(moved.widgets[0]!.title).toBeUndefined();
    await expect(
      ops({ kind: "widget_remove", name: "one" }, { kind: "widget_remove", name: "missing" }),
    ).rejects.toBeInstanceOf(BoardValidationError);
    expect(await snapshot()).toEqual(moved);
  }));

it("retains byte-frozen grants, identity and metadata", () =>
  withStore(async ({ store, document, grant, ops }) => {
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
    await expect(grant(widget.name, widget.revision, "old-instance")).rejects.toMatchObject({
      code: "conflict",
    });
    await grant(widget.name, widget.revision, widget.instanceId);
    const narrowed = await store.putWidget({
      ...input,
      name: "new-preference",
      declared: { netOrigins: ["https://example.com"] },
    });
    expect(narrowed.resolvedWidgetName).toBe(widget.name);
    expect(narrowed.widgets[1]!.grantState).toBe("granted");
    const metadata = await store.getSnapshotWithHtmlViewMetadata(target);
    expect(await document(widget.name)).toEqual({
      ...metadata.htmlViewMetadata.get(widget.name),
      html: "<p>hello</p>",
    });
    await store.putWidget({ ...input, content: { kind: "html", html: "<p>changed</p>" } });
    expect(await document(widget.name)).toMatchObject({
      html: "<p>changed</p>",
      grantState: "pending",
      revision: 3,
    });
    await expect(grant(widget.name, 1, widget.instanceId)).rejects.toMatchObject({
      code: "conflict",
    });
    await ops({ kind: "widget_remove", name: widget.name });
    expect(await document(widget.name)).toBeUndefined();
  }));

it("prepares MCP outside the FIFO and checks write authority", () =>
  withStore(async ({ store, app: readApp, grant, snapshot }) => {
    const first = await store.putWidget(app(), {
      resolveMcpAppInteraction: async () => {
        await store.putWidget(html("prepared"));
        return true;
      },
    });
    const widget = first.widgets.find((item) => item.name === "app")!;
    await grant("app", widget.revision, widget.instanceId);
    await store.putWidget(app("other-server"));
    expect(await readApp()).toMatchObject({
      grantState: "pending",
      descriptor: { serverName: "other-server" },
    });
    const noninteractive = await store.putWidget(app(), {
      resolveMcpAppInteraction: async () => false,
    });
    expect(noninteractive.widgets.find((item) => item.name === "app")!.grantState).toBe("none");
    expect(await readApp()).toMatchObject({ interactive: false, declaredTools: [] });
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
    expect(await snapshot()).toMatchObject({
      revision: noninteractive.revision,
      widgets: noninteractive.widgets,
    });
  }));

it("retains documents and plugin instances; resets empty boards", () =>
  withStore(async ({ put, document, ops, snapshot }) => {
    const registered = await put({
      name: "report",
      title: "Report",
      content: {
        kind: "registered",
        pluginKind: "example:chart",
        contentKind: "chart",
        source: "named source",
      },
    });
    expect(await document("report")).toMatchObject({
      pluginKind: "example:chart",
      source: "named source",
      title: "Report",
      revision: 1,
      viewGeneration: registered.widgets[0]!.instanceId,
    });
    const putPlugin = (count: number) =>
      put({
        name: "plugin",
        content: { kind: "plugin", pluginKind: "example", props: { count } },
      });
    const plugin = await putPlugin(1);
    const updated = await putPlugin(2);
    expect(updated.widgets[1]!.instanceId).toBe(plugin.widgets[1]!.instanceId);
    expect(updated.widgets[1]!.props).toEqual({ count: 2 });
    await ops(
      { kind: "widget_remove", name: "report" },
      { kind: "widget_remove", name: "plugin" },
      { kind: "tab_delete", tabId: "main" },
    );
    expect(await snapshot()).toEqual(empty);
  }));
