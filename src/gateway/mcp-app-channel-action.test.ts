import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTicket: vi.fn(),
  getView: vi.fn(),
  peekRuntime: vi.fn(),
}));

vi.mock("../agents/agent-bundle-mcp-manager-api.js", () => ({
  peekSessionMcpRuntime: mocks.peekRuntime,
}));
vi.mock("../agents/mcp-ui-resource.js", () => ({
  getMcpAppViewLease: mocks.getView,
}));
vi.mock("./mcp-app-standalone.js", () => ({
  createMcpAppStandaloneTicket: mocks.createTicket,
}));

import { materializeMcpAppChannelPresentation } from "./mcp-app-channel-action.js";
import {
  getTailscalePublishedOrigin,
  prepareTailscalePublishedOrigin,
} from "./tailscale-published-origin.js";

const nowMs = 1_800_000_000_000;
const runtime = { sessionId: "runtime-session", mcpAppsEnabled: true };
const view = {
  viewId: "view-latest",
  sessionId: runtime.sessionId,
  expiresAtMs: nowMs + 60_000,
  html: "do-not-emit-html",
  toolInput: { privateInput: "do-not-emit-input" },
  toolResult: { privateResult: "do-not-emit-result" },
};
const channelView = { viewId: view.viewId, title: "do-not-emit-title" };
const sessionKey = "agent:main:do-not-emit-session";

function publishOrigin(origin = "https://node.tailnet.ts.net", mode: "serve" | "funnel" = "serve") {
  return prepareTailscalePublishedOrigin({ origin, mode });
}

const materialize = () =>
  materializeMcpAppChannelPresentation({ sessionKey, view: channelView, nowMs });
const resetTailscalePublishedOrigin = () => publishOrigin("https://reset.test")();

beforeEach(() => {
  vi.clearAllMocks();
  resetTailscalePublishedOrigin();
  mocks.peekRuntime.mockReturnValue(runtime);
  mocks.getView.mockReturnValue(view);
  mocks.createTicket.mockReturnValue({
    ticket: "opaque-ticket",
    url: "/__openclaw__/mcp-app#opaque-ticket",
    expiresAtMs: nowMs + 60_000,
  });
});

afterEach(resetTailscalePublishedOrigin);

describe("Tailscale published origin", () => {
  it("stores one lifecycle-owned Serve or Funnel snapshot", () => {
    const clearServe = publishOrigin();
    const clearFunnel = publishOrigin("https://public.example.ts.net/", "funnel");

    expect(getTailscalePublishedOrigin()).toMatchObject({
      origin: "https://public.example.ts.net",
      mode: "funnel",
    });
    clearServe();
    expect(getTailscalePublishedOrigin()).toBeDefined();
    clearFunnel();
    expect(getTailscalePublishedOrigin()).toBeUndefined();
  });

  it.each(["http://node.test", "https://%75@node.test", "https://node.test/path"])(
    "rejects unsafe origin %s",
    (origin) => {
      expect(() => publishOrigin(origin)).toThrow("absolute HTTPS origin");
    },
  );
});

describe("materializeMcpAppChannelPresentation", () => {
  it("mints late and emits only one typed action with an opaque ticket", () => {
    publishOrigin();
    const presentation = materialize();

    expect(mocks.createTicket).toHaveBeenCalledExactlyOnceWith({
      sessionKey,
      view,
      toolOperationsAuthorized: true,
      nowMs,
    });
    const button = {
      label: "Open app",
      action: {
        type: "web-app",
        url: "https://node.tailnet.ts.net/__openclaw__/mcp-app#opaque-ticket",
      },
    };
    expect(presentation).toEqual({ blocks: [{ type: "buttons", buttons: [button] }] });
  });

  it.each([
    ["missing origin", resetTailscalePublishedOrigin],
    ["missing view", () => mocks.getView.mockReturnValue(undefined)],
    ["expired view", () => mocks.getView.mockReturnValue({ ...view, expiresAtMs: nowMs })],
    ["ticket capacity", () => mocks.createTicket.mockReturnValue(undefined)],
  ])("omits the action for %s", (_name, arrange) => {
    publishOrigin();
    arrange();
    expect(materialize()).toBeUndefined();
  });
});
