import { describe, expect, it } from "vitest";
import { startHoverMarquee, stopHoverMarquee } from "./hover-marquee.ts";

function buildRow(params: { textWidth: number; labelWidth: number }) {
  const row = document.createElement("div");
  const label = document.createElement("span");
  label.className = "hover-marquee";
  label.textContent = "Fix stale iMessage group-allowlist warning copy";
  row.append(label);
  document.body.append(row);
  Object.defineProperty(label, "clientWidth", { value: params.labelWidth });
  Object.defineProperty(label, "scrollWidth", { value: params.textWidth });
  return { row, label };
}

describe("hover marquee", () => {
  it("scrolls overflowing labels by the clipped distance and restores on leave", () => {
    const { row, label } = buildRow({ textWidth: 320, labelWidth: 180 });
    startHoverMarquee(row);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(true);
    expect(label.style.getPropertyValue("--hover-marquee-shift")).toBe("-140px");
    expect(label.style.getPropertyValue("--hover-marquee-duration")).toBe("1750ms");
    stopHoverMarquee(row);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
  });

  it("keeps short scroll distances readable with a minimum duration", () => {
    const { row, label } = buildRow({ textWidth: 190, labelWidth: 180 });
    startHoverMarquee(row);
    expect(label.style.getPropertyValue("--hover-marquee-shift")).toBe("-10px");
    expect(label.style.getPropertyValue("--hover-marquee-duration")).toBe("300ms");
  });

  it("leaves labels that fit untouched", () => {
    const { row, label } = buildRow({ textWidth: 120, labelWidth: 180 });
    startHoverMarquee(row);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
    expect(label.style.getPropertyValue("--hover-marquee-shift")).toBe("");
  });

  it("ignores hosts without a marquee label", () => {
    const row = document.createElement("div");
    expect(() => {
      startHoverMarquee(row);
      stopHoverMarquee(row);
    }).not.toThrow();
  });
});
