// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://control.example/"}
import { afterEach, describe, expect, it } from "vitest";
import type { BoardWidget } from "../types.ts";
import "./website.ts";

function widget(url: string): BoardWidget {
  return {
    name: "website",
    tabId: "main",
    title: "Team status",
    contentKind: "plugin",
    pluginKind: "session:website",
    props: { url },
    sizeW: 12,
    sizeH: 8,
    position: 0,
    grantState: "none",
    revision: 1,
  };
}

async function mount(url: string, active = true) {
  const element = document.createElement("openclaw-website-widget");
  element.widget = widget(url);
  element.active = active;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

afterEach(() => document.body.replaceChildren());

describe("website dashboard widget", () => {
  it("preserves a loaded website across hidden presentation and metadata changes", async () => {
    const element = await mount("https://status.example/dashboard", false);
    expect(element.querySelector("iframe")).toBeNull();
    element.active = true;
    await element.updateComplete;
    const frame = element.querySelector("iframe")!;
    expect(frame.title).toBe("Team status");
    expect(frame.src).toBe("https://status.example/dashboard");
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
    );
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    const link = element.querySelector("a")!;
    expect(link.href).toBe(frame.src);
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    element.active = false;
    element.widget = { ...widget(frame.src), title: "Renamed status", revision: 2 };
    await element.updateComplete;
    expect(element.querySelector("iframe")).toBe(frame);
    expect(frame.title).toBe("Renamed status");
    element.widget = widget("https://status.example/updated");
    await element.updateComplete;
    expect(frame.src).toBe("https://status.example/updated");
    expect(element.querySelector("a")?.href).toBe(frame.src);
  });

  it.each(["javascript:alert(1)", "data:text/html,hi", "https://user:secret@example.com"])(
    "never loads an invalid saved website: %s",
    async (url) => {
      const element = await mount(url);
      expect(element.querySelector('[role="alert"]')).not.toBeNull();
      expect(element.querySelector("iframe,a")).toBeNull();
    },
  );

  it.each(["https://control.example/settings", "https://control.example:4444/settings"])(
    "keeps %s outside the website sandbox",
    async (url) => {
      const element = await mount(url);
      expect(element.querySelector("iframe")).toBeNull();
      expect(element.querySelector('[role="alert"]')?.textContent).toContain(
        "Gateway and Control UI pages cannot be embedded",
      );
      expect(element.querySelector("a")?.href).toBe(url);
      element.widget = widget("https://external.example/dashboard");
      await element.updateComplete;
      expect(element.querySelector("iframe")?.src).toBe("https://external.example/dashboard");
    },
  );
});
