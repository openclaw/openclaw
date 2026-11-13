import { flush } from "solid-js";
/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { CapabilityList } from "./capability-list.tsx";

function renderList(caps: string[]) {
  const container = document.createElement("div");
  mountSolid(() => CapabilityList({ caps }), { container });
  flush();
  return container;
}

function items(container: Element) {
  return Array.from(container.querySelectorAll(".device-capability"));
}

describe("device capability list", () => {
  it("names a known capability with its explanation and no icon", () => {
    const container = renderList(["browser"]);
    const item = container.querySelector(".device-capability");

    expect(item?.textContent?.trim()).toBe("Browser");
    expect(item?.getAttribute("title")).toBe("Browse and interact with web pages.");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("reads as one sentence", () => {
    expect(renderList(["browser", "file", "pi-sessions"]).textContent).toBe(
      "Browser, Files, 1 runtime",
    );
  });

  it.each([
    {
      caps: [
        "claude-sessions",
        "codex-cli-sessions",
        "codex-cli-session-source",
        "codex-app-server-threads",
        "opencode-sessions",
        "pi-sessions",
        "pi-sessions",
      ],
      label: "5 runtimes",
      title:
        "claude-sessions, codex-cli-sessions, codex-app-server-threads, opencode-sessions, pi-sessions",
    },
    {
      caps: ["codex-cli-sessions", "codex-cli-session-source"],
      label: "1 runtime",
      title: "codex-cli-sessions",
    },
    {
      caps: ["codex-cli-session-source"],
      label: "1 runtime",
      title: "codex-cli-sessions",
    },
  ])("collapses session runtimes into one item: $caps", ({ caps, label, title }) => {
    const list = items(renderList(["browser", ...caps]));
    const runtime = list.find((item) => item.textContent?.trim() === label);

    expect(list).toHaveLength(2);
    expect(runtime?.getAttribute("title")).toBe(title);
  });

  it("preserves prototype-named capabilities as plain names", () => {
    const cap = "__proto__";
    const item = renderList([cap]).querySelector(".device-capability");

    expect(item?.textContent?.trim()).toBe(cap);
    expect(item?.getAttribute("title")).toBe(cap);
  });

  it.each([
    { runtimes: [], overflow: 4 },
    { runtimes: ["claude-sessions", "pi-sessions"], overflow: 5 },
  ])("bounds the grouped list and reports overflow: %j", ({ runtimes, overflow }) => {
    const capabilities = Array.from({ length: 20 }, (_, index) => `custom-${index}`);
    const container = renderList([...runtimes, ...capabilities]);
    const list = items(container);
    const more = list.find((item) => item.textContent?.trim() === `+${overflow}`);

    expect(list).toHaveLength(17);
    expect(more?.getAttribute("title")).toBe(`${overflow} more capabilities`);
    expect(container.textContent).toContain("custom-0");
    expect(container.textContent).not.toContain("custom-19");
  });
});
