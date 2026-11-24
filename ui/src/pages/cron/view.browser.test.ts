import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { createCronViewJob, getElement, renderCronView } from "./view.test-support.ts";
import "../../styles/base.css";
import "../../styles/settings.css";
import "../../styles/cron.css";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");
const alignmentTolerancePx = 2;

afterEach(() => {
  document.body.replaceChildren();
});

function centerY(bounds: DOMRect) {
  return bounds.top + bounds.height / 2;
}

async function nextFrame() {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

describe.skipIf(!hasBrowserLayout)("cron editor browser layout", () => {
  it("wraps long saved facts between the clock and Edit without clipping the delivery mode", async () => {
    const job = createCronViewJob("release-digest", {
      schedule: { kind: "cron", expr: "30 9 * * 1-5", tz: "America/New_York" },
      sessionTarget: "isolated",
      payload: {
        kind: "agentTurn",
        message: "Draft the digest.",
        model: "example/" + "longname".repeat(12),
      },
      delivery: { mode: "announce" },
    });
    const detail = await renderCronView({ editingJob: job, detailTab: "history" });
    detail.style.inlineSize = "366px";
    await nextFrame();
    const facts = getElement(detail, ".cron-prompt__facts", HTMLSpanElement);
    const ink = document.createRange();
    ink.selectNodeContents(facts);
    const lines = Array.from(ink.getClientRects());
    const clock = getElement(
      detail,
      ".cron-prompt__clock svg",
      SVGSVGElement,
    ).getBoundingClientRect();
    const edit = getElement(
      detail,
      ".cron-prompt__edit",
      HTMLButtonElement,
    ).getBoundingClientRect();
    const first = expectDefined(lines[0], "first line of schedule facts");
    expect(lines.length).toBeGreaterThan(1);
    expect(Math.abs(centerY(first) - centerY(clock))).toBeLessThanOrEqual(alignmentTolerancePx);
    expect(first.left).toBeGreaterThan(clock.right);
    expect(lines.every((line) => line.right <= edit.left)).toBe(true);
    expect(Math.abs(centerY(edit) - centerY(clock))).toBeLessThanOrEqual(alignmentTolerancePx);
  });

  it("vertically centers the configured trigger status with the Advanced heading", async () => {
    const details = document.createElement("details");
    details.className = "cron-advanced";
    details.open = true;
    details.innerHTML = `
      <summary class="settings-section__heading cron-advanced__summary">Advanced</summary>
    `;
    document.body.append(details);

    const summary = expectDefined(
      details.querySelector<HTMLElement>(".cron-advanced__summary"),
      "Advanced summary",
    );
    const heading = document.createRange();
    heading.selectNode(expectDefined(summary.firstChild, "Advanced heading text"));

    summary.insertAdjacentHTML(
      "beforeend",
      `
        <span class="cron-trigger-summary">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 3v12"></path>
            <path d="M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"></path>
          </svg>
          Trigger configured
        </span>
      `,
    );
    await nextFrame();

    const status = expectDefined(
      details.querySelector<HTMLElement>(".cron-trigger-summary"),
      "configured trigger status",
    );
    const headingCenter = centerY(heading.getBoundingClientRect());
    const statusCenter = centerY(status.getBoundingClientRect());

    expect(Math.abs(statusCenter - headingCenter)).toBeLessThanOrEqual(alignmentTolerancePx);
  });
});
