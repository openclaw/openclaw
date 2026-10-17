import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { latestBrowserTabCards, loadBrowserTabThumbnail } from "./browser-tab-preview.ts";
import { extractToolCardsCached } from "./tool-cards.ts";

afterEach(() => vi.unstubAllGlobals());

const route = { target: "host", profile: "managed" } as const;
const mediaScope = { resourceBasePath: "/gateway", authToken: null };
type Tab = Parameters<typeof loadBrowserTabThumbnail>[0]["tab"];
const hostTab = { ...route, targetId: "t1" };
const nodeTab = { ...hostTab, target: "node", node: "node-a" } as const;
const tabKey = (targetId = "tab-1") => JSON.stringify(["host", null, "managed", targetId]);
const selection = (revision: string, targetId = "tab-1") => ({
  tab: { ...route, targetId },
  revision,
});
function screenshotRequest(tab: Tab = { ...route, targetId: "tab-1" }) {
  return [
    "browser.request",
    {
      method: "POST",
      path: "/screenshot",
      target: tab.target,
      ...(tab.node ? { node: tab.node } : {}),
      query: { profile: tab.profile },
      body: { targetId: tab.targetId, type: "png" },
    },
  ];
}

function browserResult(callId: string, targetId = "tab-1", url?: string) {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: "browser",
    content: "ok",
    details: { browserTab: { ...route, targetId, url } },
  };
}

function screenshotClient() {
  const request = vi.fn().mockResolvedValue({ path: "/tmp/shot.png", targetId: "tab-1" });
  const client = createTestGatewayClient(request);
  const fetchMock = vi.fn<typeof fetch>(
    async () => new Response(new Blob(["shot"], { type: "image/png" })),
  );
  vi.stubGlobal("fetch", fetchMock);
  const load = (revision: string, tab: Tab = { ...route, targetId: "tab-1" }) =>
    loadBrowserTabThumbnail({ client, tab, revision, ...mediaScope });
  return { request, fetchMock, load };
}

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
    [tabKey(), selection("new")],
    [tabKey("tab-2"), selection("other", "tab-2")],
  ]);
  expect([...latestBrowserTabCards([older], [latest])]).toEqual([[tabKey(), selection("new")]]);
});

it("follows a newer tab without a web preview", () => {
  const web = browserResult("web", "web-tab", "https://example.com");
  const focused = browserResult("focus", "focused-tab");
  expect(extractToolCardsCached(web)[0]?.preview?.kind).toBe("browser-tab");
  expect(extractToolCardsCached(focused)[0]?.preview).toBeUndefined();
  expect([...latestBrowserTabCards([web], [focused]).values()].at(-1)).toEqual(
    selection("focus", "focused-tab"),
  );
});

it("shares captures, serializes new revisions, and reads bytes only over HTTP", async () => {
  const params = screenshotClient();
  const deferred = createDeferred<{ path: string }>();
  params.request.mockReturnValueOnce(deferred.promise);
  const first = params.load("one");
  expect(params.load("one")).toBe(first);
  await Promise.resolve();
  const second = params.load("two");
  expect(params.request).toHaveBeenCalledTimes(1);
  deferred.resolve({ path: "/tmp/first.png" });
  expect(await first).toBe("data:image/png;base64,c2hvdA==");
  expect(await second).toBe("data:image/png;base64,c2hvdA==");
  await params.load("one");
  await params.load("two");
  expect(params.request.mock.calls).toEqual([screenshotRequest(), screenshotRequest()]);
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

it.each([
  ["profile", hostTab, { ...hostTab, profile: "work" }, false],
  ["target", hostTab, nodeTab, false],
  ["node", nodeTab, { ...nodeTab, node: "node-b" }, false],
  ["Gateway", hostTab, hostTab, true],
] as const)("isolates the same tab and revision by %s", async (_, first, tab, separateClient) => {
  const params = screenshotClient();
  await params.load("same", first);
  await params.load("same", first);
  const next = separateClient ? screenshotClient() : params;
  await next.load("same", tab);
  await next.load("same", tab);
  expect(params.request).toHaveBeenCalledTimes(separateClient ? 1 : 2);
  expect(next.request.mock.calls).toEqual(
    separateClient ? [screenshotRequest(tab)] : [screenshotRequest(first), screenshotRequest(tab)],
  );
});
