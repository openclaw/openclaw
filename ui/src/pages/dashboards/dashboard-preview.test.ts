/* @vitest-environment jsdom */

import type { BoardSnapshot } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { DashboardPreviewLoader } from "./dashboard-preview.ts";
import "./dashboard-preview.ts";

type PreviewElement = HTMLElement & {
  sessionKey: string;
  agentId?: string;
  load?: DashboardPreviewLoader | null;
  updateComplete: Promise<boolean>;
};

function widget(
  name: string,
  tabId: string,
  sizeW: number,
  sizeH: number,
  position: number,
  extra: Partial<BoardSnapshot["widgets"][number]> = {},
): BoardSnapshot["widgets"][number] {
  return {
    name,
    tabId,
    contentKind: "html",
    sizeW,
    sizeH,
    position,
    grantState: "none",
    revision: 1,
    ...extra,
  };
}

const snapshot: BoardSnapshot = {
  sessionKey: "agent:main:dashboard:release",
  revision: 3,
  tabs: [
    { tabId: "later", title: "Later", position: 1, chatDock: "hidden" },
    { tabId: "main", title: "Overview", position: 0, chatDock: "right" },
  ],
  widgets: [
    widget("revenue", "main", 8, 4, 0, {
      title: "Revenue by month, including refunds, chargebacks, and regional adjustments",
    }),
    widget("errors", "main", 4, 4, 1, { contentKind: "plugin", kindLabel: "Error rate" }),
    widget("hidden", "later", 12, 2, 0, { title: "Not on the first tab" }),
  ],
};

async function mount(
  props: Partial<Pick<PreviewElement, "sessionKey" | "agentId" | "load">>,
): Promise<PreviewElement> {
  const element = document.createElement("openclaw-dashboard-preview") as PreviewElement;
  Object.assign(element, { sessionKey: snapshot.sessionKey }, props);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

describe("dashboard preview", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("draws one labeled widget per rect once the board loads", async () => {
    const load = vi.fn(async () => snapshot);
    const element = await mount({ load, agentId: "main" });
    await vi.waitFor(() => expect(element.querySelectorAll("svg g")).toHaveLength(2));

    expect(load).toHaveBeenCalledWith({
      sessionKey: snapshot.sessionKey,
      agentId: "main",
    });
    const labels = Array.from(element.querySelectorAll("svg text"), (text) =>
      text.textContent?.trim(),
    );
    expect(labels[0]).toMatch(/^Revenue by month.*…$/);
    expect(labels[1]).toBe("Error rate");
    expect(
      Array.from(element.querySelectorAll("svg g > rect:first-child"), (rect) => [
        rect.getAttribute("x"),
        rect.getAttribute("width"),
      ]),
    ).toEqual([
      ["0.04", "7.92"],
      ["8.04", "3.92"],
    ]);
    expect(element.textContent).not.toContain("Not on the first tab");
    expect(element.querySelector(".dashboard-preview__widget--plugin")).not.toBeNull();
    expect(element.querySelector(".dashboard-preview")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows loading before the gateway is ready and unavailable only after the gate rejects", async () => {
    const waiting = await mount({ load: undefined });
    expect(waiting.querySelector(".dashboard-preview--loading")).not.toBeNull();
    expect(waiting.textContent).not.toContain("Preview unavailable");

    waiting.load = null;
    await waiting.updateComplete;
    await vi.waitFor(() => expect(waiting.textContent).toContain("Preview unavailable"));
  });

  it("ignores an older request after the loader is replaced", async () => {
    let resolveFirst: ((value: BoardSnapshot) => void) | undefined;
    let resolveSecond: ((value: BoardSnapshot) => void) | undefined;
    const first = new Promise<BoardSnapshot>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<BoardSnapshot>((resolve) => {
      resolveSecond = resolve;
    });
    const element = await mount({ load: () => first });
    element.load = () => second;
    await element.updateComplete;

    resolveSecond?.({
      ...snapshot,
      revision: 4,
      widgets: [widget("revenue", "main", 8, 4, 0, { title: "Fresh layout", revision: 4 })],
    });
    await vi.waitFor(() => expect(element.textContent).toContain("Fresh layout"));
    resolveFirst?.(snapshot);
    await Promise.resolve();
    expect(element.textContent).toContain("Fresh layout");
    expect(element.textContent).not.toContain("Revenue by month");
  });

  it("shows an empty state for boards without widgets and a fallback after failure", async () => {
    const empty = await mount({ load: async () => ({ ...snapshot, widgets: [] }) });
    await vi.waitFor(() => expect(empty.textContent).toContain("No widgets yet"));

    const failed = await mount({
      load: async () => {
        throw new Error("boom");
      },
    });
    await vi.waitFor(() => expect(failed.textContent).toContain("Preview unavailable"));
  });
});
