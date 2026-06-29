/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, t } from "../../i18n/index.ts";
import type { ChatAccordionView } from "../types/chat-types.ts";
import { renderTopicAccordion } from "./topic-accordion.ts";

vi.mock("../icons.ts", () => ({
  icons: {},
}));

const VIEW: ChatAccordionView = {
  boxes: [
    { id: "box-live", label: "Voice", state: "live", summary: null },
    { id: "box-folded", label: "Coding", state: "collapsed", summary: "Refactored loader" },
  ],
  spans: [],
};

afterEach(async () => {
  await i18n.setLocale("en");
});

describe("topic accordion strip", () => {
  it("renders nothing when the unified-session gate is off", () => {
    const container = document.createElement("div");
    render(
      renderTopicAccordion({ enabled: false, accordion: VIEW, onToggleTopic: () => undefined }),
      container,
    );
    expect(container.querySelector(".chat-topics")).toBeNull();
  });

  it("renders nothing when there are no topic boxes", () => {
    const container = document.createElement("div");
    render(
      renderTopicAccordion({
        enabled: true,
        accordion: { boxes: [], spans: [] },
        onToggleTopic: () => undefined,
      }),
      container,
    );
    expect(container.querySelector(".chat-topics")).toBeNull();
  });

  it("renders a control per box reflecting live/collapsed state", () => {
    const container = document.createElement("div");
    render(
      renderTopicAccordion({ enabled: true, accordion: VIEW, onToggleTopic: () => undefined }),
      container,
    );
    const topics = container.querySelectorAll<HTMLButtonElement>(".chat-topic");
    expect(topics).toHaveLength(2);

    const live = container.querySelector<HTMLButtonElement>(".chat-topic--live");
    const collapsed = container.querySelector<HTMLButtonElement>(".chat-topic--collapsed");
    expect(live?.getAttribute("aria-pressed")).toBe("true");
    expect(live?.textContent).toContain("Voice");
    expect(collapsed?.getAttribute("aria-pressed")).toBe("false");
    expect(collapsed?.textContent).toContain("Coding");
  });

  it("toggles a live box to collapsed and a collapsed box to live", () => {
    const container = document.createElement("div");
    const onToggleTopic = vi.fn();
    render(renderTopicAccordion({ enabled: true, accordion: VIEW, onToggleTopic }), container);

    container.querySelector<HTMLButtonElement>(".chat-topic--live")!.click();
    expect(onToggleTopic).toHaveBeenCalledWith("box-live", "collapsed");

    container.querySelector<HTMLButtonElement>(".chat-topic--collapsed")!.click();
    expect(onToggleTopic).toHaveBeenCalledWith("box-folded", "live");
  });

  it("falls back to a summary or placeholder label when a box is unlabeled", () => {
    const container = document.createElement("div");
    render(
      renderTopicAccordion({
        enabled: true,
        accordion: {
          boxes: [
            { id: "b1", label: null, state: "collapsed", summary: "Summary text" },
            { id: "b2", label: null, state: "live", summary: null },
          ],
          spans: [],
        },
        onToggleTopic: () => undefined,
      }),
      container,
    );
    const labels = [...container.querySelectorAll(".chat-topic__label")].map((el) =>
      el.textContent?.trim(),
    );
    expect(labels).toContain("Summary text");
    expect(labels).toContain(t("chat.topics.untitled"));
  });
});
