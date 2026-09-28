/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page.test/"} */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep this complete mock in the dedicated unit-mock-registry project.
vi.mock("./chat-pane.ts", () => ({}));

import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createSessionTitleSource,
  createSplitLayout,
  setLayout,
  setNavigationContext,
  stubMatchMedia,
} from "./chat-page.test-support.ts";
import { ChatPage } from "./chat-page.ts";

type RenderedPane = HTMLElement & { presentationTitle: string | undefined };

describe("chat page session refresh", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    localStorage.clear();
    stubMatchMedia(false);
  });

  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("coalesces shared list publications and commits split toolbar titles inside a frame", async () => {
    const page = new ChatPage();
    const source = createSessionTitleSource();
    const navigation = setNavigationContext(page);
    (page as unknown as { context: unknown }).context = {
      ...navigation.context,
      agents: { state: { agentsList: null } },
      gateway: {
        ...navigation.context.gateway,
        snapshot: { assistantAgentId: "main", client: null, hello: null, phase: "stopped" },
        subscribe: () => () => undefined,
      },
      sessions: source.sessions,
    };
    page.data = { sessionKey: "main" };
    document.body.append(page);
    const layout = createSplitLayout("main");
    layout.activePaneId = expectDefined(layout.columns[0]?.panes[0], "active main pane").id;
    const foreignPane = expectDefined(layout.columns[1]?.panes[0], "foreign-agent pane");
    foreignPane.sessionKey = "agent:research:dashboard:retained";
    setLayout(page, layout);
    await page.updateComplete;

    const presentationTitles = () =>
      [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")].map(
        (pane) => pane.presentationTitle,
      );
    expect(presentationTitles()).toEqual([undefined, undefined]);

    // Rows arrive under the canonical agent key while the route still says
    // "main"; hello-default resolution plus equivalence matching must find
    // the label anyway — including non-default agent ids.
    (page as unknown as { context: { gateway?: unknown; sessions: unknown } }).context.gateway = {
      ...navigation.context.gateway,
      snapshot: {
        assistantAgentId: "dev",
        client: null,
        hello: {
          snapshot: {
            sessionDefaults: {
              defaultAgentId: "dev",
              mainKey: "main",
              mainSessionKey: "agent:dev:main",
            },
          },
        },
        phase: "stopped",
      },
      subscribe: () => () => undefined,
    };
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    let insideFrame = false;
    const offFrameUpdates: string[] = [];
    const originalRequestUpdate = page.requestUpdate.bind(page);
    vi.spyOn(page, "requestUpdate").mockImplementation((...args) => {
      if (!insideFrame) {
        offFrameUpdates.push("page");
      }
      originalRequestUpdate(...args);
    });
    const originalRender = page.render.bind(page);
    vi.spyOn(page, "render").mockImplementation(() => {
      if (!insideFrame) {
        offFrameUpdates.push("pane bindings");
      }
      return originalRender();
    });
    source.publish("agent:dev:main", "Loading desk");
    source.publish("agent:dev:main", "Main desk");
    expect(offFrameUpdates).toEqual([]);
    expect(presentationTitles()).toEqual([undefined, undefined]);
    expect(frames).toHaveLength(1);
    insideFrame = true;
    expectDefined(frames[0], "scheduled render frame")(0);
    insideFrame = false;
    await page.updateComplete;

    expect(presentationTitles()).toEqual(["Main desk", undefined]);
    expect(offFrameUpdates).toEqual([]);

    page.remove();
    expect(source.listeners.size).toBe(0);
  });

  it("moves session updates to a replacement context source", async () => {
    const first = createSessionTitleSource();
    const second = createSessionTitleSource();
    const page = new ChatPage();
    const sharedContext = {
      ...setNavigationContext(page).context,
      agents: { state: { agentsList: null } },
      gateway: {
        setSessionKey: vi.fn(),
        snapshot: { assistantAgentId: "main", client: null, hello: null, phase: "stopped" },
        subscribe: () => () => undefined,
      },
    };
    (page as unknown as { context: unknown }).context = {
      ...sharedContext,
      sessions: first.sessions,
    };
    page.data = { sessionKey: "main" };
    document.body.append(page);
    setLayout(page, createSplitLayout("main"));
    await page.updateComplete;
    const presentationTitles = () =>
      [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")].map(
        (pane) => pane.presentationTitle,
      );
    first.publish("agent:main:main", "First desk");
    await new Promise(requestAnimationFrame);
    await page.updateComplete;
    expect(presentationTitles()).toEqual(["First desk", "First desk"]);

    second.publish("agent:main:main", "Second desk");
    (page as unknown as { context: unknown }).context = {
      ...sharedContext,
      sessions: second.sessions,
    };
    page.requestUpdate();
    await page.updateComplete;
    expect(first.listeners.size).toBe(0);
    expect(presentationTitles()).toEqual(["Second desk", "Second desk"]);

    const requestUpdate = vi.spyOn(page, "requestUpdate");
    first.publish("agent:main:main", "Retired desk");
    expect(requestUpdate).not.toHaveBeenCalled();
    expect(presentationTitles()).toEqual(["Second desk", "Second desk"]);
    second.publish("agent:main:main", "Updated desk");
    await new Promise(requestAnimationFrame);
    await page.updateComplete;
    expect(presentationTitles()).toEqual(["Updated desk", "Updated desk"]);

    page.remove();
    expect(second.listeners.size).toBe(0);
    requestUpdate.mockClear();
    second.publish("agent:main:main", "Disposed desk");
    expect(requestUpdate).not.toHaveBeenCalled();
  });
});
