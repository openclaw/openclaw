import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import "../../test-helpers/load-styles.ts";
import { createBrowserClient } from "./browser-panel-controller-test-support.ts";
import "./browser-panel.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps simultaneous chat panels scoped to their own tabs on one shared browser", async () => {
  await page.viewport(1360, 780);
  const tabs = [
    {
      tabId: "t1",
      targetId: "research",
      title: "Research notes",
      url: "https://research.example/notes",
    },
    {
      tabId: "t2",
      targetId: "release",
      title: "Release checklist",
      url: "https://release.example/checklist",
    },
  ];
  const keys = ["agent:main:research", "agent:main:release"];
  const gateway = createBrowserClient(async (request) => {
    if (request.path === "/tabs") {
      const index = keys.indexOf(request.sessionKey ?? "");
      return { running: true, tabs: index < 0 ? tabs : [tabs[index]] };
    }
    const tab = tabs.find((entry) => entry.tabId === request.body?.targetId) ?? tabs[0]!;
    if (request.path === "/screenshot") {
      return { path: "/synthetic/" + tab.targetId + ".svg", targetId: tab.targetId, url: tab.url };
    }
    if (request.path === "/act") {
      return { result: { cssWidth: 800, cssHeight: 600, title: tab.title, url: tab.url } };
    }
    return { ok: true };
  });
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/__openclaw__/assistant-media")) {
      return originalFetch(input, init);
    }
    const title = url.includes("release") ? "Release checklist" : "Research notes";
    return Promise.resolve(
      new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#f5f7fa"/><text x="48" y="80" font-family="sans-serif" font-size="30" fill="#172033">' +
          title +
          '</text><text x="48" y="125" font-family="sans-serif" font-size="18" fill="#495469">Pages for this conversation</text></svg>',
        { headers: { "Content-Type": "image/svg+xml" } },
      ),
    );
  });
  const panels = keys.map((key, index) => {
    const section = document.createElement("section");
    section.style.cssText =
      "width:640px;height:700px;display:inline-block;vertical-align:top;margin:12px";
    const heading = document.createElement("h2");
    heading.textContent = index === 0 ? "Research session" : "Release session";
    section.append(heading);
    const panel = document.createElement("openclaw-browser-panel");
    panel.style.cssText = "display:block;height:620px";
    panel.client = gateway.client;
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.sessionKey = key;
    panel.preferredTab = {
      tab: { target: "host", profile: "openclaw", targetId: tabs[index]!.tabId },
      revision: "initial",
    };
    section.append(panel);
    document.body.append(section);
    return panel;
  });
  for (const panel of panels) {
    await expect.poll(() => panel.shadowRoot?.querySelector(".bp-shot")).not.toBeNull();
  }
  expect(panels[0]!.hostedTabs.map((tab) => tab.id)).toEqual(["t1"]);
  expect(panels[1]!.hostedTabs.map((tab) => tab.id)).toEqual(["t2"]);
  expect(
    gateway.request.mock.calls.every(([, value]) =>
      keys.includes((value as { sessionKey: string }).sessionKey),
    ),
  ).toBe(true);
});
