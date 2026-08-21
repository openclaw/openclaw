import { afterEach, describe, expect, it } from "vitest";
import { createOverflowFadeRef } from "./overflow-fade.ts";

function buildRow(params: { textWidth: number; titleWidth: number; direction?: "ltr" | "rtl" }) {
  const row = document.createElement("div");
  const title = document.createElement("span");
  title.className = "sidebar-recent-session__name";
  title.style.direction = params.direction ?? "ltr";
  const content = document.createElement("span");
  content.className = "sidebar-recent-session__name-content";
  content.textContent = "Fix stale iMessage group-allowlist warning copy";
  const badge = document.createElement("span");
  badge.className = "session-row-badge";
  title.append(content);
  row.append(title, badge);
  document.body.append(row);
  Object.defineProperty(title, "clientWidth", { value: params.titleWidth });
  Object.defineProperty(content, "scrollWidth", { value: params.textWidth });
  return { row, title, content, badge };
}

describe("overflow fade", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("marks only genuinely clipped titles for a resting fade", () => {
    const clipped = buildRow({ textWidth: 320, titleWidth: 180 });
    createOverflowFadeRef()(clipped.title);
    expect(clipped.title.hasAttribute("data-overflow-fade")).toBe(true);

    const fitting = buildRow({ textWidth: 120, titleWidth: 180 });
    createOverflowFadeRef()(fitting.title);
    expect(fitting.title.hasAttribute("data-overflow-fade")).toBe(false);
  });

  it("reveals only the hidden tail without changing badges", () => {
    const { title, badge } = buildRow({ textWidth: 320, titleWidth: 180 });
    const badgeBefore = badge.outerHTML;

    createOverflowFadeRef()(title);

    expect(title.hasAttribute("data-overflow-reveal")).toBe(true);
    expect(title.style.getPropertyValue("--overflow-reveal-translate")).toBe("-140px");
    expect(title.style.getPropertyValue("--overflow-reveal-duration")).toBe("2240ms");
    expect(badge.outerHTML).toBe(badgeBefore);
  });

  it("leaves fitting titles untouched", () => {
    const { title } = buildRow({ textWidth: 120, titleWidth: 180 });
    createOverflowFadeRef()(title);
    expect(title.hasAttribute("data-overflow-reveal")).toBe(false);
    expect(title.style.getPropertyValue("--overflow-reveal-translate")).toBe("");
  });

  it("bounds reveal duration and reverses travel for RTL", () => {
    const short = buildRow({ textWidth: 190, titleWidth: 180 });
    createOverflowFadeRef()(short.title);
    expect(short.title.style.getPropertyValue("--overflow-reveal-duration")).toBe("1200ms");

    const long = buildRow({ textWidth: 900, titleWidth: 180, direction: "rtl" });
    createOverflowFadeRef()(long.title);
    expect(long.title.style.getPropertyValue("--overflow-reveal-translate")).toBe("720px");
    expect(long.title.style.getPropertyValue("--overflow-reveal-duration")).toBe("8000ms");
  });

  it("ignores detached refs", () => {
    expect(() => createOverflowFadeRef()(undefined)).not.toThrow();
  });
});
