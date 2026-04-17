/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../types.ts";
import {
  getContextNoticeViewModel,
  renderContextNotice,
  resetContextNoticeThemeCacheForTest,
} from "./context-notice.ts";

describe("context notice", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--warn");
    document.documentElement.style.removeProperty("--danger");
    resetContextNoticeThemeCacheForTest();
  });

  it("renders only for fresh high current usage", () => {
    const container = document.createElement("div");
    document.documentElement.style.setProperty("--warn", "rgb(1, 2, 3)");
    document.documentElement.style.setProperty("--danger", "tomato");
    resetContextNoticeThemeCacheForTest();

    expect(
      getContextNoticeViewModel(
        {
          key: "main",
          kind: "direct",
          updatedAt: null,
          inputTokens: 757_300,
          totalTokens: 46_000,
          contextTokens: 200_000,
        },
        200_000,
      ),
    ).toBeNull();

    const session: GatewaySessionRow = {
      key: "main",
      kind: "direct",
      updatedAt: null,
      inputTokens: 757_300,
      totalTokens: 190_000,
      contextTokens: 200_000,
    };
    render(renderContextNotice(session, 200_000), container);

    expect(container.textContent).toContain("95% context used");
    expect(container.textContent).toContain("190k / 200k");
    expect(container.textContent).not.toContain("757.3k / 200k");
    const notice = container.querySelector<HTMLElement>(".context-notice");
    expect(notice).not.toBeNull();
    expect(notice?.style.getPropertyValue("--ctx-color")).toContain("rgb(");
    expect(notice?.style.getPropertyValue("--ctx-color")).not.toContain("NaN");
    expect(notice?.style.getPropertyValue("--ctx-bg")).not.toContain("NaN");

    const icon = container.querySelector<SVGElement>(".context-notice__icon");
    expect(icon).not.toBeNull();
    expect(icon?.tagName.toLowerCase()).toBe("svg");
    expect(icon?.classList.contains("context-notice__icon")).toBe(true);
    expect(icon?.getAttribute("width")).toBe("16");
    expect(icon?.getAttribute("height")).toBe("16");
    expect(icon?.querySelector("path")).not.toBeNull();

    expect(
      getContextNoticeViewModel(
        {
          key: "main",
          kind: "direct",
          updatedAt: null,
          inputTokens: 500_000,
          contextTokens: 200_000,
        },
        200_000,
      ),
    ).toBeNull();
    expect(
      getContextNoticeViewModel(
        {
          key: "main",
          kind: "direct",
          updatedAt: null,
          totalTokens: 190_000,
          totalTokensFresh: false,
          contextTokens: 200_000,
        },
        200_000,
      ),
    ).toBeNull();
  });
});
