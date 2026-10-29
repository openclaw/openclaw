import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { BrowserTabTarget } from "../../components/browser/browser-target.ts";
import { latestBrowserTabCards, loadBrowserTabThumbnail } from "./browser-tab-preview.ts";
import { extractToolCardsCached } from "./tool-cards.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const route = { target: "host", profile: "managed" } as const;
const tabKey = (targetId = "tab-1") => JSON.stringify(["host", null, "managed", targetId]);
const selected = (revision: string, targetId = "tab-1") => [
  tabKey(targetId),
  { tab: { ...route, targetId }, revision },
];

function browserResult(callId: string, targetId = "tab-1") {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: "browser",
    content: "ok",
    details: { browserTab: { ...route, targetId } },
  };
}

function screenshotClient() {
  const request = vi.fn().mockResolvedValue({ path: "/tmp/shot.png", targetId: "tab-1" });
  const client = { request } as unknown as GatewayBrowserClient;
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () =>
        ({ ok: true, blob: async () => new Blob(["shot"], { type: "image/png" }) }) as Response,
    );
  vi.stubGlobal("fetch", fetchMock);
  const params = {
    client,
    request,
    fetchMock,
    tab: { ...route, targetId: "tab-1" },
    resourceBasePath: "/gateway",
    authToken: null,
  };
  const load = (revision: string, tab: BrowserTabTarget = params.tab) =>
    loadBrowserTabThumbnail({ ...params, tab, revision });
  return { ...params, load };
}

describe("browser tab previews", () => {
  it("keeps anonymous result revisions stable across reads but distinct across results", () => {
    const message = {
      role: "toolResult",
      toolName: "browser",
      details: { browserTab: { ...route, targetId: "tab-1" } },
    };
    const initial = latestBrowserTabCards([message], []).get(tabKey())?.revision;
    expect(initial).toBeTruthy();
    expect(extractToolCardsCached(message)[0]?.previewRevision).toBe(initial);
    expect(latestBrowserTabCards([message, { ...message }], []).get(tabKey())?.revision).not.toBe(
      initial,
    );
  });

  it("does not repeat captures when image retention evicts an old tab", async () => {
    const params = screenshotClient();
    for (let index = 0; index < 33; index++) {
      await params.load("one", { ...route, targetId: `tab-${index}` });
    }
    expect(await params.load("one", { ...route, targetId: "tab-0" })).toBeUndefined();
    expect(params.request).toHaveBeenCalledTimes(33);
  });

  it("selects only the latest successful completed result, before filtering rows", () => {
    const older = browserResult("old");
    const latest = browserResult("new");
    const other = browserResult("other", "tab-2");
    const failed = { ...browserResult("failed"), isError: true };
    const running = {
      role: "assistant",
      __openclawToolStreamLive: true,
      content: [
        { type: "toolcall", id: "running", name: "browser", arguments: {} },
        { type: "toolresult", id: "running", name: "browser", details: older.details },
      ],
    };
    expect([...latestBrowserTabCards([null, older, latest, other], [failed, running])]).toEqual([
      selected("new"),
      selected("other", "tab-2"),
    ]);
    expect([...latestBrowserTabCards([older], [latest])]).toEqual([selected("new")]);
  });

  it("shares captures, serializes new revisions, and reads bytes only over HTTP", async () => {
    const params = screenshotClient();
    const deferred = createDeferred<{ path: string }>();
    params.request.mockReturnValueOnce(deferred.promise);
    const first = params.load("one");
    expect(params.load("one")).toBe(first);
    await vi.waitFor(() => expect(params.request).toHaveBeenCalledTimes(1));
    const second = params.load("two");
    expect(params.request).toHaveBeenCalledTimes(1);
    deferred.resolve({ path: "/tmp/first.png" });
    expect(await first).toBe("data:image/png;base64,c2hvdA==");
    expect(await second).toBe("data:image/png;base64,c2hvdA==");
    await params.load("one");
    await params.load("two");
    expect(params.request).toHaveBeenCalledTimes(2);
    expect(params.fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/gateway/__openclaw__/assistant-media?source=%2Ftmp%2Ffirst.png",
      "/gateway/__openclaw__/assistant-media?source=%2Ftmp%2Fshot.png",
    ]);
  });

  it.each(["capture", "fetch"])("caches a %s failure until a new revision", async (failure) => {
    const params = screenshotClient();
    if (failure === "capture") {
      params.request.mockRejectedValueOnce(new Error("closed"));
    } else {
      params.fetchMock.mockRejectedValueOnce(new Error("offline"));
    }
    const first = params.load("one");
    expect(await first).toBeUndefined();
    expect(await params.load("one")).toBeUndefined();
    expect(params.request).toHaveBeenCalledTimes(1);
    expect(await params.load("two")).toBe("data:image/png;base64,c2hvdA==");
    expect(params.request).toHaveBeenCalledTimes(2);
  });

  it("separates identical tab ids and revisions by host, node, and profile", async () => {
    const params = screenshotClient();
    const tabs = [
      { target: "host", profile: "managed", targetId: "t1" },
      { target: "host", profile: "work", targetId: "t1" },
      { target: "node", node: "node-a", profile: "managed", targetId: "t1" },
      { target: "node", node: "node-b", profile: "managed", targetId: "t1" },
    ] as const;
    for (const tab of tabs) {
      await params.load("same", tab);
      await params.load("same", tab);
    }
    expect(params.request).toHaveBeenCalledTimes(tabs.length);
  });

  it("never reuses a shot from another Gateway client", async () => {
    const params = screenshotClient();
    await params.load("one");
    const next = screenshotClient();
    await next.load("one");
    expect(next.request).toHaveBeenCalledTimes(1);
  });
});
