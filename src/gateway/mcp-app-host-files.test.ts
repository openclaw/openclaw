import { type PathLike, type Stats, statSync, watchFile, writeFileSync } from "node:fs";
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate as settle } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SessionMcpRuntime } from "../agents/agent-bundle-mcp-types.js";
import { fetchMcpAppView, getMcpAppViewLease } from "../agents/mcp-ui-resource.js";
import { testing as viewTesting } from "../agents/mcp-ui-resource.test-support.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  acceptGatewayDeviceSourceAuthority,
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "./device-revocation.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

const state = vi.hoisted(() => ({
  root: "",
  sessionId: "session-1",
  execNode: undefined as string | undefined,
  repositoryWorkspaceId: undefined as string | undefined,
}));
const statRead = vi.hoisted(() =>
  vi.fn<
    (path: PathLike, callback: (error: NodeJS.ErrnoException | null, stats?: Stats) => void) => void
  >(),
);
function sessionEntry() {
  return {
    sessionId: state.sessionId,
    execNode: state.execNode,
    repositoryWorkspaceId: state.repositoryWorkspaceId,
  };
}
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    stat: statRead.mockImplementation(actual.stat),
    watchFile: vi.fn(actual.watchFile),
  };
});
vi.mock("./operator-role-policy.js", () => ({ resolveGatewayOperatorRoleActor: () => undefined }));
vi.mock("./server-methods/session-scoped-read.js", () => ({
  retainSessionScopedRead: () => undefined,
}));
// mock-isolation: File handles use a fixture workspace without opening real session storage.
vi.mock("./server-methods/session-files-root.js", () => ({
  prepareLocalSessionWorkspaceRoot: async () => {
    const root = state.root;
    return {
      root,
      assertCurrent: () => {
        if (root !== state.root) {
          throw new Error("App file workspace authority changed");
        }
      },
    };
  },
}));
vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadGatewaySessionEntryReadOnlyAsync: async (sessionKey: string) => ({
    cfg: {},
    agentId: "main",
    canonicalKey: sessionKey,
    storePath: state.root,
    entry: sessionEntry(),
  }),
}));
vi.mock("../config/sessions/session-entry-read-facts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-entry-read-facts.js")>()),
  readRetainedSessionEntryFacts: (_database: unknown, request: { sessionKeys: string[] }) => ({
    entries: request.sessionKeys.map((sessionKey) => ({
      sessionKey,
      entry: sessionEntry(),
    })),
  }),
}));
// mock-isolation: Host-file tests supply the bound session identity without opening session storage.
vi.mock("./session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: async () => ({ entry: sessionEntry() }),
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
const session = { sessionKey, agentId: "main" };
const fileTarget = { ...session, path: "part.stl" };
const tool = { serverName: "demo", toolName: "edit", uiResourceUri: "ui://demo/editor" };
const filePath = () => path.join(state.root, "part.stl");
const fileContents = (encoding?: "utf8") => readFile(filePath(), encoding ?? null);
let viewId: string;
let uri: string;
let allowed: boolean;
let connection: AbortController;
const publish = vi.fn();
let runtime: SessionMcpRuntime;
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
function read(params: Record<string, unknown> = {}) {
  return invoke("mcp.app.readResource", { uri, ...params });
}
function write(params: Record<string, unknown>, profileId = "alice") {
  return invoke("mcp.app.writeResource", { uri, ...params }, profileId);
}
async function subscribe() {
  expect((await invoke("mcp.app.subscribeResource", { uri }))[0]).toBe(true);
}
function nextUpdate() {
  const notified = createDeferred();
  publish.mockClear();
  publish.mockImplementation(() => notified.resolve());
  return notified.promise;
}
function expectDisposers(count: number) {
  expect(getMcpAppViewLease(viewId, runtime)?.disposeCallbacks?.size).toBe(count);
}
function expectUpdate() {
  expect(publish).toHaveBeenCalledWith(
    "mcp.app.resourceUpdated",
    { viewId, uri },
    new Set(["alice"]),
  );
}
beforeEach(async () => {
  state.root = dirs.make("mcp-host-file-");
  state.sessionId = "session-1";
  state.execNode = undefined;
  state.repositoryWorkspaceId = undefined;
  allowed = true;
  connection = new AbortController();
  publish.mockReset();
  await writeFile(filePath(), "solid original");
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
  const hostFile = await prepareMcpAppHostFile(options({}), fileTarget);
  uri = hostFile.resourceUri;
  const descriptor = await fetchMcpAppView({
    runtime,
    agentId: "main",
    ...tool,
    toolInput: { file: { name: hostFile.name, resourceUri: uri } },
    toolResult: { content: [] },
    allowedAppToolNames: new Set(),
    authorizeAppInteraction: () => allowed,
    requesterId: "alice",
    hostFile,
  });
  viewId = descriptor!.viewId;
});
afterEach(() => {
  viewTesting.clearViewStore();
  memorySessionActorOwners.reset();
  vi.unstubAllEnvs();
});

describe("registered MCP App host-file routes", () => {
  it("keeps memory file handles after their opening RPC and refuses them after owner closure", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", state.root);
    const memoryKey = "agent:main:dashboard:incognito-file";
    const owner = memorySessionActorOwners.get({
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    });
    const actor = await owner.acquire(
      { sessionKey: memoryKey, database: owner.identity },
      { assertCurrent() {}, assertReadable() {} },
    );
    try {
      const created = await actor.storage!.mutate(
        {
          type: "session.entry.create",
          input: { entry: { sessionId: state.sessionId, updatedAt: 1, incognito: true } },
        },
        { assertCurrent() {}, authorize() {} },
      );
      expect(created.kind).toBe("committed");
      const opening = new AbortController();
      const assertOpeningCurrent = () => opening.signal.throwIfAborted();
      const file = await runWithSessionActorStorage(
        {
          actor,
          agentId: "main",
          path: owner.path,
          authority: { assertCurrent: assertOpeningCurrent, authorize: assertOpeningCurrent },
        },
        () =>
          prepareMcpAppHostFile(
            { ...options({}), signal: opening.signal },
            { ...fileTarget, sessionKey: memoryKey },
          ),
      );
      runtime.sessionKey = memoryKey;
      getMcpAppViewLease(viewId, runtime)!.hostFile = file;
      opening.abort();
      const target = { sessionKey: memoryKey, uri: file.resourceUri };
      const result = await read({
        ...target,
        _meta: { "openai/resource": { representation: "text" } },
      });
      expect(result[0]).toBe(true);
      expect(result[1].contents[0].text).toBe("solid original");
      memorySessionActorOwners.closeDatabase(owner);
      expect((await read(target))[0]).toBe(false);
    } finally {
      await actor.release();
    }
  });

  it("mints opaque URIs and serves explicit text/blob representations without host paths", async () => {
    expect(uri.startsWith("openclaw-file://")).toBe(true);
    expect(uri).not.toContain("part.stl");
    const text = await read({ _meta: { "openai/resource": { representation: "text" } } });
    expect(text[0]).toBe(true);
    expect(text[1].contents[0]).toMatchObject({
      uri,
      text: "solid original",
      _meta: { "openai/resource": { writable: true, etag: expect.any(String) } },
    });
    expect(JSON.stringify(text[1])).not.toContain(state.root);
    const blob = await read();
    expect(blob[1].contents[0].blob).toBe(Buffer.from("solid original").toString("base64"));
  });

  it("requires writable read admission and reports saved/conflict/too-large without overwriting conflicts", async () => {
    expect((await write({ text: "no read" }))[0]).toBe(false);
    const result = await read();
    const etag = result[1].contents[0]._meta["openai/resource"].etag;
    const saved = await write({ text: "solid edited", ifMatch: etag });
    expect(saved[1]).toMatchObject({ outcome: "saved", etag: expect.any(String) });
    const conflict = await write({ text: "stale", ifMatch: etag });
    expect(conflict[1]).toEqual({ outcome: "conflict", etag: saved[1].etag });
    const large = await write({ blob: Buffer.alloc(256 * 1024 + 1).toString("base64") });
    expect(large[1]).toEqual({ outcome: "too-large", maxBytes: 256 * 1024 });
    expect(await fileContents("utf8")).toBe("solid edited");
  });

  it("round-trips binary writes and rejects forged URI, foreign requester, and revoked grant", async () => {
    await read();
    const bytes = Buffer.from([0, 255, 1]);
    expect((await write({ blob: bytes.toString("base64") }))[1].outcome).toBe("saved");
    expect(await fileContents()).toEqual(bytes);
    expect((await read({ uri: "openclaw-file://forged" }))[0]).toBe(false);
    expect((await write({ text: "foreign" }, "bob"))[0]).toBe(false);
    allowed = false;
    expect((await write({ text: "revoked" }))[0]).toBe(false);
    expect(await fileContents()).toEqual(bytes);
  });

  it("rechecks workspace session identity and synchronously revoked grant before file commit", async () => {
    await read();
    const view = getMcpAppViewLease(viewId, runtime)!;
    let assertions = 0;
    view.authorizeAppInteraction = () => ++assertions < 4;
    expect((await write({ text: "not committed" }))[0]).toBe(false);
    expect(await fileContents("utf8")).toBe("solid original");
    view.authorizeAppInteraction = () => true;
    state.sessionId = "replacement";
    expect((await read())[0]).toBe(false);
  });

  it.each(["execNode", "repositoryWorkspaceId"] as const)(
    "revokes retained file reads and writes after %s ownership changes",
    async (field) => {
      expect((await read())[0]).toBe(true);
      state[field] = "remote-owner";
      expect((await read())[0]).toBe(false);
      expect((await write({ text: "not committed" }))[0]).toBe(false);
      expect(await fileContents("utf8")).toBe("solid original");
    },
  );

  it("publishes after a rename gap and subsequent writes", async () => {
    let notified = nextUpdate();
    await subscribe();
    const file = filePath();
    await rename(file, `${file}.bak`);
    await notified;
    await settle();
    expectDisposers(1);
    notified = nextUpdate();
    await writeFile(file, "solid replacement");
    await notified;
    expectUpdate();
    notified = nextUpdate();
    await writeFile(file, "solid updated replacement");
    await notified;
    expectUpdate();
    connection.abort();
    expectDisposers(0);
    expect((await read())[0]).toBe(false);
  });

  it("publishes when the file returns after a missing stat but before the poller baseline", async ({
    signal,
  }) => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const file = filePath();
    let missing: Error | undefined;
    let deliveredMissing = false;
    const recreateAfterMissingStat = (): Error => {
      if (missing) {
        return missing;
      }
      try {
        statSync(file);
      } catch (error) {
        expect(error).toMatchObject({ code: "ENOENT" });
        if (!(error instanceof Error)) {
          throw error;
        }
        missing = error;
      }
      if (!missing) {
        throw new Error("Expected the renamed file to be missing");
      }
      writeFileSync(file, "solid replacement after the missing stat");
      return missing;
    };
    // A change-based poller can take its initial baseline after the file returns,
    // while the independent stat still delivers its earlier missing observation.
    vi.mocked(watchFile).mockImplementationOnce((...args) => {
      recreateAfterMissingStat();
      return actual.watchFile(...args);
    });
    statRead.mockImplementation((pathname, callback) => {
      if (pathname !== file) {
        actual.stat(pathname, callback);
        return;
      }
      if (!deliveredMissing) {
        const error = recreateAfterMissingStat();
        deliveredMissing = true;
        callback(error);
      } else {
        callback(null, statSync(file));
      }
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const renamed = nextUpdate();
      await subscribe();
      await rename(file, `${file}.bak`);
      await withinTest(renamed, signal);
      expect(deliveredMissing).toBe(true);
      publish.mockClear();
      await vi.advanceTimersByTimeAsync(250);
      expectUpdate();
    } finally {
      connection.abort();
      statRead.mockImplementation(actual.stat);
      vi.mocked(watchFile).mockReset().mockImplementation(actual.watchFile);
      vi.useRealTimers();
    }
  });

  it("stops polling when the connection closes during a rename gap", async ({ signal }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const notified = nextUpdate();
      await subscribe();
      const file = filePath();
      await rename(file, `${file}.bak`);
      await withinTest(notified, signal);
      connection.abort();
      expectDisposers(0);
      publish.mockClear();
      statRead.mockClear();
      await writeFile(file, "solid replacement after abort");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(statRead).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      connection.abort();
      vi.useRealTimers();
    }
  });

  it("rearms when the file returns before the poller's initial stat", async ({ signal }) => {
    const file = filePath();
    const rearmed = createDeferred();
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    statRead.mockImplementationOnce((pathname, callback) => {
      writeFileSync(file, "solid replacement before the initial stat");
      actual.stat(pathname, (error, current) => {
        callback(error, current);
        rearmed.resolve();
      });
    });
    try {
      await subscribe();
      await rename(file, `${file}.bak`);
      await withinTest(rearmed.promise, signal);
      await settle();
      expectUpdate();
      const notified = nextUpdate();
      await writeFile(file, "solid updated replacement");
      await withinTest(notified, signal);
      expectUpdate();
    } finally {
      connection.abort();
      statRead.mockReset().mockImplementation(actual.stat);
    }
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
    const file = filePath();
    for (const change of ["append", "atomic rename"]) {
      const notified = nextUpdate();
      if (change === "append") {
        await appendFile(file, "\nsolid appended");
      } else {
        await writeFile(`${file}.tmp`, "solid replaced");
        await rename(`${file}.tmp`, file);
      }
      await withinTest(notified, signal);
      expectUpdate();
    }
    invalidateGatewayDeviceRevocation(request.context, "viewer");
    expect(device.isCurrent()).toBe(false);
    connection.abort();
    expectDisposers(0);
  });

  it("registers and removes subscriptions through the same view authority", async () => {
    await subscribe();
    expect((await invoke("mcp.app.unsubscribeResource", { uri }))[0]).toBe(true);
    expect((await invoke("mcp.app.subscribeResource", { uri: "openclaw-file://foreign" }))[0]).toBe(
      false,
    );
  });
});
