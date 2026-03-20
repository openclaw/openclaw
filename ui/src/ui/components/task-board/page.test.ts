/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderTaskBoardPage } from "./page.ts";

function renderToText(template: unknown) {
  const root = document.createElement("div");
  render(template, root);
  return root.textContent ?? "";
}

describe("renderTaskBoardPage", () => {
  it("shows no-data banner and lane empty states", () => {
    const text = renderToText(
      renderTaskBoardPage({
        loading: false,
        error: null,
        cards: [],
        lastLoadedAt: null,
        onRefresh: () => undefined,
      }),
    );

    expect(text).toContain("当前没有可展示的数据");
    expect(text).toContain("当前没有可显示的主动任务");
    expect(text).toContain("当前没有可显示的定时任务");
  });

  it("shows error banner without falling back to no-data banner", () => {
    const text = renderToText(
      renderTaskBoardPage({
        loading: false,
        error: "boom",
        cards: [],
        lastLoadedAt: null,
        onRefresh: () => undefined,
      }),
    );

    expect(text).toContain("读取失败");
    expect(text).toContain("boom");
    expect(text).not.toContain("当前没有可展示的数据");
  });
});
