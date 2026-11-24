import { afterEach, describe, expect, it, vi } from "vitest";
import { createPendingSettingsTarget } from "./settings-target-arrival.ts";

const ARRIVAL = "data-settings-arrival";

function settingRow(id = "gateway.publicOrigin") {
  const row = document.createElement("div");
  row.className = "settings-row";
  row.id = id;
  const title = document.createElement("span");
  title.id = `${id}-title`;
  title.textContent = "Public origin";
  row.append(title);
  document.body.append(row);
  const scroll = vi.fn();
  row.scrollIntoView = scroll;
  return { row, scroll };
}

/** Runs queued frames one at a time, as a browser would between layouts. */
function animationFrames() {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames[id - 1] = () => {};
  });
  let next = 0;
  return {
    run(count: number) {
      for (let index = 0; index < count && next < frames.length; index += 1) {
        frames[next++]!(0);
      }
    },
  };
}

function arrive(targetId: string) {
  const frames = animationFrames();
  const pending = createPendingSettingsTarget(() => document.body);
  pending.request(targetId);
  pending.commit();
  // The first frame finds the rendered target and starts its scroll.
  frames.run(1);
  return { frames, pending };
}

describe("createPendingSettingsTarget", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("marks and focuses a setting row only after its scroll has stopped", () => {
    const { row, scroll } = settingRow();
    let top = 900;
    vi.spyOn(row, "getBoundingClientRect").mockImplementation(() => ({ top }) as DOMRect);
    const { frames } = arrive(row.id);
    expect(scroll).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ block: "center" }));
    for (top = 800; top > 400; top -= 100) {
      frames.run(1);
    }
    expect(row.hasAttribute(ARRIVAL)).toBe(false);
    expect(document.activeElement).not.toBe(row);

    frames.run(6);
    expect(row.hasAttribute(ARRIVAL)).toBe(true);
    expect(document.activeElement).toBe(row);
    expect(row.getAttribute("role")).toBe("group");
    expect(row.getAttribute("aria-labelledby")).toBe("gateway.publicOrigin-title");
  });

  it.each(["pointerdown", "keydown"])("ends the mark on the reader's first %s", (type) => {
    const { row } = settingRow();
    arrive(row.id).frames.run(6);
    expect(row.hasAttribute(ARRIVAL)).toBe(true);
    document.dispatchEvent(new Event(type));
    expect(row.hasAttribute(ARRIVAL)).toBe(false);
  });

  it("never marks a row whose link was replaced before the scroll stopped", () => {
    const { row } = settingRow();
    const { frames, pending } = arrive(row.id);
    frames.run(2);
    pending.request(null);
    frames.run(6);
    expect(row.hasAttribute(ARRIVAL)).toBe(false);
  });

  it("marks a provider row like a settings row", () => {
    const { row } = settingRow("providers.openai");
    row.className = "provider-row";
    arrive(row.id).frames.run(6);
    expect(row.hasAttribute(ARRIVAL)).toBe(true);
    expect(document.activeElement).toBe(row);
  });

  it("lands on the enclosing setting when the linked one has no row", () => {
    const { row } = settingRow("agents.defaults.modelPolicy");
    arrive("agents.defaults.modelPolicy.allow").frames.run(6);
    expect(row.hasAttribute(ARRIVAL)).toBe(true);
  });

  it("opens a closed disclosure around the setting", () => {
    const { row } = settingRow();
    const details = document.createElement("details");
    document.body.append(details);
    details.append(row);
    arrive(row.id);
    expect(details.open).toBe(true);
  });

  it("scrolls a larger block to the top without marking or focusing it", () => {
    const section = document.createElement("section");
    section.id = "config-section-gateway";
    document.body.append(section);
    const scroll = vi.fn();
    section.scrollIntoView = scroll;
    arrive(section.id).frames.run(6);
    expect(scroll).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ block: "start" }));
    expect(section.hasAttribute(ARRIVAL)).toBe(false);
    expect(document.activeElement).not.toBe(section);
  });
});
