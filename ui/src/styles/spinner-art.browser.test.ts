import { afterEach, describe, expect, it } from "vitest";
import "../test-helpers/load-styles.ts";
import "./approval.css";
import "./custodian.css";
import "./device-pair-setup.css";
import "./panel-loading-skeleton.css";
import "./sidebar-agent-roster.css";
import "./wizard-sign-in.css";
import "./wizard-step-controls.css";
import "../pages/chat/components/chat-activity-pills.css";
import "../pages/chat/components/chat-details-processes.css";
import "../pages/chat/components/chat-details-subagents.css";
import "../pages/chat/components/session-worker-stop-dialog.css";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

// Spinners sit in the flex or grid parents they render in; bare inline spans draw no box.
// data-art names the mask token each spinner drew before its mask moved to a static child.
const fixture = `
  <span class="session-glyph"><span id="ring" data-art="--spinner-mask-avatar" class="session-glyph__ring"></span></span>
  <span class="session-glyph session-glyph--bare"><span id="bare-ring" data-art="--spinner-mask" class="session-glyph__ring"></span></span>
  <button class="btn" type="button"><span id="btn" data-art="--spinner-mask" class="btn__spinner"></span>Saving</button>
  <span id="run" data-art="--spinner-mask" class="session-run-spinner"></span>
  <span class="sidebar-online__running"><span id="online" data-art="--spinner-mask-small" class="session-run-spinner"></span></span>
  <span class="sidebar-session-team-state" style="position:relative;display:block;width:12px;height:12px">
    <span id="roster" data-art="--spinner-mask" class="session-glyph__ring"></span>
  </span>
  <div class="chat-activity-pills">
    <span id="pill" data-art="--spinner-mask" class="activity-pill__spinner"></span>
    <span class="activity-pill__badge"><span id="pill-badge" data-art="--spinner-mask-small" class="activity-pill__spinner"></span></span>
    <span class="activity-pill__flow" style="display:block;position:relative;width:40px;height:20px">
      <span id="atlas" class="activity-pill__atlas"></span>
    </span>
  </div>
  <span id="processes" data-art="--spinner-mask-small" class="chat-details-processes__spinner"></span>
  <span id="subagents" data-art="--spinner-mask-small" class="chat-details-subagents__spinner"></span>
  <span class="session-worker-stop__button-state">
    <span id="worker-stop" data-art="--spinner-mask" class="session-worker-stop__spinner"></span>
  </span>
  <div id="approval" data-art="--spinner-mask-large" class="approval-page__spinner"></div>
  <span id="custodian" data-art="--spinner-mask" class="custodian__history-spinner"></span>
  <div class="device-pair-setup__loading"><span id="device-pair" data-art="--spinner-mask" class="device-pair-setup__spinner"></span></div>
  <openclaw-panel-loading-skeleton>
    <div class="desktop-loading"><span id="panel" data-art="--spinner-mask-large" class="desktop-spinner"></span></div>
  </openclaw-panel-loading-skeleton>
  <span style="position:relative;display:block;width:40px;height:40px">
    <span id="sign-in" data-art="--spinner-mask-large" class="wizard-sign-in__ring"></span>
  </span>
  <div class="wizard-step__progress"><span id="wizard-step" data-art="--spinner-mask" class="wizard-step__spinner"></span></div>
`;

afterEach(() => {
  document.body.replaceChildren();
});

function tokenMask(token: string) {
  const probe = document.body.appendChild(document.createElement("span"));
  probe.style.mask = `var(${token})`;
  const mask = getComputedStyle(probe).maskImage;
  probe.remove();
  return mask;
}

// One string per box, so a failure prints the full computed value.
function paint(target: HTMLElement, pseudo = "") {
  const style = getComputedStyle(target, pseudo);
  return `${target.id}${pseudo}: ${style.animationName} | ${style.maskImage} | ${style.backgroundColor} | ${style.width} ${style.height}`;
}

describe.skipIf(!hasBrowserLayout)("spinner art", () => {
  // A mask that turns with its element makes WebKit redraw it every frame while idle.
  it("rotates unmasked hosts around their static masked art", () => {
    document.body.innerHTML = fixture;
    const spinners = [...document.querySelectorAll<HTMLElement>("[data-art]")];
    expect(spinners).toHaveLength(17);
    for (const spinner of spinners) {
      const { id, dataset } = spinner;
      const { animationName, color, width, height } = getComputedStyle(spinner);
      expect(`${id} ${animationName}`).toMatch(/-spin$/);
      expect(paint(spinner)).toBe(
        `${id}: ${animationName} | none | rgba(0, 0, 0, 0) | ${width} ${height}`,
      );
      expect(paint(spinner, "::before")).toBe(
        `${id}::before: none | ${tokenMask(dataset.art!)} | ${color} | ${width} ${height}`,
      );
    }

    const atlas = document.querySelector<HTMLElement>("#atlas")!;
    const { width, height } = getComputedStyle(atlas);
    expect(paint(atlas)).toBe(
      `atlas: activity-pill-frames | none | rgba(0, 0, 0, 0) | ${width} ${height}`,
    );
    const accent = document.body.appendChild(document.createElement("span"));
    accent.style.color = "var(--accent)";
    const frames = paint(atlas, "::before");
    expect(frames).toMatch(/^atlas::before: none \| url\(.*chat-activity-pills-atlas.*\) \| /);
    expect(frames).toContain(` | ${getComputedStyle(accent).color} | ${width} ${height}`);
  });
});
