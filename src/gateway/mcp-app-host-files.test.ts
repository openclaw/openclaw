import { watchFile, writeFileSync } from "node:fs";
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SessionMcpRuntime } from "../agents/agent-bundle-mcp-types.js";
import { fetchMcpAppView, getMcpAppViewLease } from "../agents/mcp-ui-resource.js";
import { testing as viewTesting } from "../agents/mcp-ui-resource.test-support.js";
import {
  acceptGatewayDeviceSourceAuthority,
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "./device-revocation.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

const state = vi.hoisted(() => ({ root: "", sessionId: "session-1" }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, watchFile: vi.fn(actual.watchFile) };
});
vi.mock("./operator-role-policy.js", () => ({ resolveGatewayOperatorRoleActor: () => undefined }));
vi.mock("./server-methods/session-scoped-read.js", () => ({
  retainSessionScopedRead: () => undefined,
}));
vi.mock("./server-methods/sessions-files.js", () => ({
  resolveLocalSessionWorkspaceRoot: () => state.root,
}));
vi.mock("./session-utils.js", () => ({
  loadGatewaySessionEntryReadOnly: () => ({ entry: { sessionId: state.sessionId } }),
}));
vi.mock("../agents/agent-bundle-mcp-manager-cleanup.js", () => ({
  completeDeferredSessionMcpRuntimeRetirement: async () => false,
}));
vi.mock("../agents/agent-bundle-mcp-manager-api.js", () => ({
  peekSessionMcpRuntime: () => undefined,
}));
vi.mock("./mcp-app-reconstruction.js", () => ({ restoreMcpAppView: async () => undefined }));
vi.mock("./mcp-app-standalone.js", () => ({ createMcpAppStandaloneTicket: () => undefined }));

import { prepareMcpAppHostFile } from "./mcp-app-host-files.js";
import { mcpAppHandlers } from "./server-methods/mcp-app.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:test";
let viewId: string;
let uri: string;
let allowed: boolean;
let connection: AbortController;
const publish = vi.fn();
let runtime: SessionMcpRuntime;
const disposers: Array<() => void> = [];
function options(params: Record<string, unknown>, profileId = "alice") {
  return {
    params,
    client: {
      connId: profileId,
      connectionSignal: connection.signal,
      connect: { scopes: ["operator.write"] },
      authenticatedUserProfile: { profileId },
    },
    context: {
      getRuntimeConfig: () => ({ mcp: { apps: { enabled: true } } }),
      broadcastToConnIds: publish,
    },
  } as unknown as GatewayRequestHandlerOptions;
}
async function invoke(method: string, params: Record<string, unknown>, profileId = "alice") {
  const respond = vi.fn();
  await mcpAppHandlers[method]!({
    ...options({ sessionKey, viewId, ...params }, profileId),
    respond,
  });
  return respond.mock.calls[0]!;
}

beforeEach(async () => {
  state.root = dirs.make("mcp-host-file-");
  state.sessionId = "session-1";
  allowed = true;
  connection = new AbortController();
  publish.mockReset();
  await writeFile(path.join(state.root, "part.stl"), "solid original");
  runtime = {
    sessionId: state.sessionId,
    sessionKey,
    mcpAppsEnabled: true,
    markUsed() {},
    readResource: async () => ({
      contents: [
        { uri: "ui://demo/editor", mimeType: "text/html;profile=mcp-app", text: "<p>editor</p>" },
      ],
    }),
  } as unknown as SessionMcpRuntime;
  const hostFile = await prepareMcpAppHostFile(options({}), {
    sessionKey,
    agentId: "main",
    path: "part.stl",
  });
  uri = hostFile.resourceUri;
  const descriptor = await fetchMcpAppView({
    runtime,
    agentId: "main",
    serverName: "demo",
    toolName: "edit",
    uiResourceUri: "ui://demo/editor",
    toolInput: { file: { name: hostFile.name, resourceUri: uri } },
    toolResult: { content: [] },
    allowedAppToolNames: new Set(),
    authorizeAppInteraction: () => allowed,
    requesterId: "alice",
    hostFile,
  });
  viewId = descriptor!.viewId;
  const view = getMcpAppViewLease(viewId, runtime)!;
  disposers.push(() => {
    clearTimeout(view.expiryTimer);
    for (const dispose of view.disposeCallbacks ?? []) {
      dispose();
    }
  });
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  viewTesting.clearViewStore();
});

describe("registered MCP App host-file routes", () => {
  it("mints opaque URIs and serves explicit text/blob representations without host paths", async () => {
    expect(uri.startsWith("openclaw-file://")).toBe(true);
    expect(uri).not.toContain("part.stl");
    const text = await invoke("mcp.app.readResource", {
      uri,
      _meta: { "openai/resource": { representation: "text" } },
    });
    expect(text[0]).toBe(true);
    expect(text[1].contents[0]).toMatchObject({
      uri,
      text: "solid original",
      _meta: { "openai/resource": { writable: true, etag: expect.any(String) } },
    });
    expect(JSON.stringify(text[1])).not.toContain(state.root);
    const blob = await invoke("mcp.app.readResource", { uri });
    expect(blob[1].contents[0].blob).toBe(Buffer.from("solid original").toString("base64"));
  });

  it("requires writable read admission and reports saved/conflict/too-large without overwriting conflicts", async () => {
    expect((await invoke("mcp.app.writeResource", { uri, text: "no read" }))[0]).toBe(false);
    const read = await invoke("mcp.app.readResource", { uri });
    const etag = read[1].contents[0]._meta["openai/resource"].etag;
    const saved = await invoke("mcp.app.writeResource", {
      uri,
      text: "solid edited",
      ifMatch: etag,
    });
    expect(saved[1]).toMatchObject({ outcome: "saved", etag: expect.any(String) });
    const conflict = await invoke("mcp.app.writeResource", { uri, text: "stale", ifMatch: etag });
    expect(conflict[1]).toEqual({ outcome: "conflict", etag: saved[1].etag });
    const large = await invoke("mcp.app.writeResource", {
      uri,
      blob: Buffer.alloc(256 * 1024 + 1).toString("base64"),
    });
    expect(large[1]).toEqual({ outcome: "too-large", maxBytes: 256 * 1024 });
    expect(await readFile(path.join(state.root, "part.stl"), "utf8")).toBe("solid edited");
  });

  it("round-trips binary writes and rejects forged URI, foreign requester, and revoked grant", async () => {
    await invoke("mcp.app.readResource", { uri });
    const bytes = Buffer.from([0, 255, 1]);
    expect(
      (await invoke("mcp.app.writeResource", { uri, blob: bytes.toString("base64") }))[1].outcome,
    ).toBe("saved");
    expect(await readFile(path.join(state.root, "part.stl"))).toEqual(bytes);
    expect((await invoke("mcp.app.readResource", { uri: "openclaw-file://forged" }))[0]).toBe(
      false,
    );
    expect((await invoke("mcp.app.writeResource", { uri, text: "foreign" }, "bob"))[0]).toBe(false);
    allowed = false;
    expect((await invoke("mcp.app.writeResource", { uri, text: "revoked" }))[0]).toBe(false);
    expect(await readFile(path.join(state.root, "part.stl"))).toEqual(bytes);
  });

  it("rechecks workspace session identity and synchronously revoked grant before file commit", async () => {
    await invoke("mcp.app.readResource", { uri });
    const view = getMcpAppViewLease(viewId, runtime)!;
    let assertions = 0;
    view.authorizeAppInteraction = () => ++assertions < 4;
    expect((await invoke("mcp.app.writeResource", { uri, text: "not committed" }))[0]).toBe(false);
    expect(await readFile(path.join(state.root, "part.stl"), "utf8")).toBe("solid original");
    view.authorizeAppInteraction = () => true;
    state.sessionId = "replacement";
    expect((await invoke("mcp.app.readResource", { uri }))[0]).toBe(false);
  });

  it("publishes only the bound resource and releases watchers when its connection closes", async () => {
    const notified = createDeferred();
    publish.mockImplementation(() => notified.resolve());
    expect((await invoke("mcp.app.subscribeResource", { uri }))[0]).toBe(true);
    await writeFile(path.join(state.root, "part.stl"), "updated by another editor");
    await notified.promise;
    expect(publish).toHaveBeenCalledWith(
      "mcp.app.resourceUpdated",
      { viewId, uri },
      new Set(["alice"]),
    );
    const view = getMcpAppViewLease(viewId, runtime)!;
    expect(view.disposeCallbacks?.size).toBe(1);
    connection.abort();
    expect(view.disposeCallbacks?.size).toBe(0);
    expect((await invoke("mcp.app.readResource", { uri }))[0]).toBe(false);
  });

  it.each(["atomic replacement", "rename gap"])(
    "publishes after %s and subsequent writes",
    async (kind) => {
      let notified = createDeferred();
      publish.mockImplementation(() => notified.resolve());
      expect((await invoke("mcp.app.subscribeResource", { uri }))[0]).toBe(true);
      const file = path.join(state.root, "part.stl");
      if (kind === "rename gap") {
        await rename(file, `${file}.bak`);
        await notified.promise;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(getMcpAppViewLease(viewId, runtime)?.disposeCallbacks?.size).toBe(1);
        notified = createDeferred();
        publish.mockClear();
        await writeFile(file, "solid replacement");
      } else {
        await writeFile(`${file}.tmp`, "solid replacement");
        await rename(`${file}.tmp`, file);
      }
      await notified.promise;
      expect(publish).toHaveBeenCalledWith(
        "mcp.app.resourceUpdated",
        { viewId, uri },
        new Set(["alice"]),
      );
      notified = createDeferred();
      publish.mockClear();
      await writeFile(file, "solid updated replacement");
      await notified.promise;
      expect(publish).toHaveBeenCalledWith(
        "mcp.app.resourceUpdated",
        { viewId, uri },
        new Set(["alice"]),
      );
      connection.abort();
      expect(getMcpAppViewLease(viewId, runtime)?.disposeCallbacks?.size).toBe(0);
    },
  );

  it("stops polling when the connection closes during a rename gap", async () => {
    const polling = vi.mocked(watchFile).mockClear();
    const notified = createDeferred();
    publish.mockImplementation(() => notified.resolve());
    expect((await invoke("mcp.app.subscribeResource", { uri }))[0]).toBe(true);
    const file = path.join(state.root, "part.stl");
    await rename(file, `${file}.bak`);
    await notified.promise;
    const poller = polling.mock.results[0]?.value;
    expect(poller).toBeDefined();
    const stopped = createDeferred();
    poller.once("stop", () => stopped.resolve());
    publish.mockClear();
    connection.abort();
    await stopped.promise;
    expect(getMcpAppViewLease(viewId, runtime)?.disposeCallbacks?.size).toBe(0);
    await writeFile(file, "solid replacement after abort");
    expect(publish).not.toHaveBeenCalled();
  });

  it("rearms when the file returns before the poller's initial stat", async ({ signal }) => {
    const file = path.join(state.root, "part.stl");
    const stopped = createDeferred();
    const { watchFile: realWatchFile } = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(watchFile).mockImplementationOnce((...args) => {
      writeFileSync(file, "solid replacement before polling starts");
      const poller = realWatchFile(...args);
      poller.once("stop", () => stopped.resolve());
      return poller;
    });
    expect((await invoke("mcp.app.subscribeResource", { uri }))[0]).toBe(true);
    await rename(file, `${file}.bak`);
    await withinTest(stopped.promise, signal);
    expect(publish).toHaveBeenCalledWith(
      "mcp.app.resourceUpdated",
      { viewId, uri },
      new Set(["alice"]),
    );
    const notified = createDeferred();
    publish.mockClear();
    publish.mockImplementation(() => notified.resolve());
    await writeFile(file, "solid updated replacement");
    await withinTest(notified.promise, signal);
    expect(publish).toHaveBeenCalledWith(
      "mcp.app.resourceUpdated",
      { viewId, uri },
      new Set(["alice"]),
    );
  });

  it("keeps file notifications alive after the accepted subscription request finishes", async ({
    signal,
  }) => {
    const request = options({ sessionKey, viewId, uri });
    const device = captureGatewayDeviceRevocation(
      request.context,
      { deviceId: "viewer", role: "operator" },
      () => true,
      connection.signal,
      { isCurrent: () => true, subscribe: () => () => {} },
    );
    request.hasCurrentClientAuthority = device.isCurrent;
    expect(acceptGatewayDeviceSourceAuthority(device.isCurrent)).toBe(true);
    const respond = vi.fn();
    await mcpAppHandlers["mcp.app.subscribeResource"]!({ ...request, respond });
    expect(respond).toHaveBeenCalledWith(true, {});
    device.release();
    const file = path.join(state.root, "part.stl");
    for (const change of ["append", "atomic rename"]) {
      const notified = createDeferred();
      publish.mockClear();
      publish.mockImplementation(() => notified.resolve());
      if (change === "append") {
        await appendFile(file, "\nsolid appended");
      } else {
        await writeFile(`${file}.tmp`, "solid replaced");
        await rename(`${file}.tmp`, file);
      }
      await withinTest(notified.promise, signal);
      expect(publish).toHaveBeenCalledWith(
        "mcp.app.resourceUpdated",
        { viewId, uri },
        new Set(["alice"]),
      );
    }
    invalidateGatewayDeviceRevocation(request.context, "viewer");
    expect(device.isCurrent()).toBe(false);
    connection.abort();
    expect(getMcpAppViewLease(viewId, runtime)?.disposeCallbacks?.size).toBe(0);
  });

  it("registers and removes subscriptions through the same view authority", async () => {
    expect((await invoke("mcp.app.subscribeResource", { uri }))[0]).toBe(true);
    expect((await invoke("mcp.app.unsubscribeResource", { uri }))[0]).toBe(true);
    expect((await invoke("mcp.app.subscribeResource", { uri: "openclaw-file://foreign" }))[0]).toBe(
      false,
    );
  });
});
