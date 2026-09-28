import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlUiClawmoji } from "../../../src/plugin-sdk/control-ui-lobsterdex.ts";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { ClawmojiElement, renderClawmoji } from "./clawmoji.ts";

const containers: HTMLElement[] = [];
const artwork = new Map<string, Blob>();
let sequence = 0;
function asset(blob: Blob): string {
  const url = `/__openclaw__/plugin-lobster-art/reef/reef/art-${sequence++}`;
  artwork.set(url, blob);
  return url;
}
beforeEach(() => {
  setAvatarGatewayOrigin(window.location.origin, ["test-clawmoji-token"]);
  vi.spyOn(window, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
      window.location.origin,
    );
    if (new Headers(init?.headers).get("Authorization") !== "Bearer test-clawmoji-token") {
      return new Response(null, { status: 401 });
    }
    const blob = artwork.get(url.pathname.replace(/^\/console/, ""));
    return new Response(blob ?? null, { status: blob ? 200 : 404 });
  });
});
afterEach(() => {
  for (const container of containers.splice(0)) {
    render(null, container);
    container.remove();
  }
  artwork.clear();
  setAvatarGatewayOrigin(null);
  vi.restoreAllMocks();
});

function atlas(): ControlUiClawmoji {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 16;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas unavailable");
  }
  context.fillStyle = "coral";
  context.fillRect(0, 0, 16, 16);
  context.fillStyle = "teal";
  context.fillRect(16, 0, 16, 16);
  return {
    id: "reef/reef/coral",
    pluginId: "reef",
    packId: "reef",
    packName: "Reef",
    source: "plugin",
    name: "Coral",
    appearance: {
      kind: "sprite-atlas",
      url: asset(
        new Blob(
          [
            Uint8Array.from(atob(canvas.toDataURL().split(",")[1] ?? ""), (character) =>
              character.charCodeAt(0),
            ),
          ],
          { type: "image/png" },
        ),
      ),
      frameWidth: 16,
      frameHeight: 16,
      animations: { idle: { frames: [0, 1], fps: 20, loop: false } },
      reducedMotionFrame: 0,
      anchor: { x: 0.5, y: 1 },
    },
  };
}

async function mount(entry: ControlUiClawmoji | null, pose: "idle" | "busy" = "idle") {
  const container = document.createElement("div");
  containers.push(container);
  document.body.append(container);
  render(renderClawmoji({ entry, pose, size: 64, label: "Coral" }), container);
  const element = container.querySelector("openclaw-clawmoji");
  if (!(element instanceof ClawmojiElement)) {
    throw new Error("Missing core renderer");
  }
  await element.updateComplete;
  return element;
}

function image(element: ClawmojiElement) {
  const result = element.querySelector("img");
  if (!result) {
    throw new Error("Missing sprite image");
  }
  return result;
}

describe("shared Clawmoji renderer", () => {
  it("renders original built-in geometry and sleeping eyes with an accessible name", async () => {
    const element = await mount({
      id: "crimson",
      name: "Crimson",
      source: "builtin",
      appearance: { kind: "builtin", paletteId: "crimson" },
    });
    element.pose = "sleeping";
    await element.updateComplete;
    expect(element.querySelector(".lob-standard-dome")).not.toBeNull();
    expect(element.querySelector(".lob-eye-open")?.getAttribute("style")).toBe("display:none");
    expect(element.querySelector("[role=img]")?.getAttribute("aria-label")).toBe("Coral");
    const rect = element.getBoundingClientRect();
    expect(rect.width).toBe(64);
    expect(rect.height).toBe(64);
  });

  it("renders custom SVG artwork through the core pose styles without inserting pack markup", async () => {
    const definition = atlas();
    definition.appearance = {
      kind: "svg",
      url: asset(
        new Blob(
          [
            '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="coral"/></svg>',
          ],
          { type: "image/svg+xml" },
        ),
      ),
      anchor: { x: 0.25, y: 1 },
    };
    const element = await mount(definition);
    element.pose = "happy";
    await element.updateComplete;
    await expect.poll(() => image(element).naturalWidth).toBe(24);
    expect(element.querySelector("svg")).toBeNull();
    const art = element.querySelector(".clawmoji__art");
    expect(art).toBeInstanceOf(HTMLElement);
    if (art instanceof HTMLElement) {
      expect(getComputedStyle(art).animationName).toBe("clawmoji-happy");
      expect(getComputedStyle(art).transformOrigin).toBe("16px 64px");
    }
  });

  it("decodes an original atlas and plays the idle fallback to its last frame", async () => {
    const element = await mount(atlas(), "busy");
    await expect.poll(() => image(element).style.transform).toBe("translate(-64px, 0px)");
    expect(image(element).naturalWidth).toBe(32);
    expect(element.querySelector(".clawmoji__art")?.getBoundingClientRect().width).toBe(64);
    expect(element.querySelector("[role=img]")?.getAttribute("data-state")).toBe("ready");
  });

  it("restarts on pose updates and reloads definitions that reuse an asset URL", async () => {
    const definition = atlas();
    const element = await mount(definition);
    await expect.poll(() => image(element).style.transform).toBe("translate(-64px, 0px)");
    const retiredImage = image(element);
    element.entry = structuredClone(definition);
    await element.updateComplete;
    retiredImage.dispatchEvent(new Event("error"));
    await expect.poll(() => image(element).style.visibility).toBe("visible");
    await expect.poll(() => image(element).style.transform).toBe("translate(-64px, 0px)");
    element.pose = "busy";
    await element.updateComplete;
    expect(image(element).style.transform).toBe("translate(0px, 0px)");
    await expect.poll(() => image(element).style.transform).toBe("translate(-64px, 0px)");
  });

  it("switches to the still frame when the motion preference changes", async () => {
    const motion = new EventTarget();
    let reduce = false;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    vi.spyOn(window, "matchMedia").mockReturnValue(
      Object.assign(media, {
        addEventListener: motion.addEventListener.bind(motion),
        removeEventListener: motion.removeEventListener.bind(motion),
      }),
    );
    Object.defineProperty(media, "matches", { configurable: true, get: () => reduce });
    const element = await mount(atlas());
    await expect.poll(() => image(element).style.transform).toBe("translate(-64px, 0px)");
    reduce = true;
    motion.dispatchEvent(new Event("change"));
    await element.updateComplete;
    expect(image(element).style.transform).toBe("translate(0px, 0px)");
    reduce = false;
    motion.dispatchEvent(new Event("change"));
    await expect.poll(() => image(element).style.transform).toBe("translate(-64px, 0px)");
  });

  it("rejects frame indexes outside the decoded image and recovers on replacement", async () => {
    const definition = atlas();
    if (definition.appearance.kind !== "sprite-atlas") {
      throw new Error("Expected atlas");
    }
    definition.appearance.animations.idle = { frames: [99], fps: 1, loop: false };
    const element = await mount(definition);
    await expect
      .poll(() => element.querySelector("[role=img]")?.getAttribute("data-state"))
      .toBe("unavailable");
    element.entry = atlas();
    await element.updateComplete;
    await expect.poll(() => element.querySelector("img")?.style.visibility).toBe("visible");
  });

  it("uses authenticated Gateway routes under the base path and replaces blobs after credentials change", async () => {
    setAvatarGatewayOrigin(window.location.origin, ["expired", "test-clawmoji-token"], "/console");
    const definition = atlas();
    const element = await mount(definition);
    await expect.poll(() => element.querySelector("img")?.style.visibility).toBe("visible");
    const firstUrl = image(element).src;
    expect(firstUrl.startsWith("blob:")).toBe(true);
    expect(window.fetch).toHaveBeenCalledWith(
      `${window.location.origin}/console${definition.appearance.kind === "builtin" ? "" : definition.appearance.url}`,
      expect.objectContaining({ headers: { Authorization: "Bearer test-clawmoji-token" } }),
    );
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    setAvatarGatewayOrigin(window.location.origin, ["test-clawmoji-token"], "/console");
    await expect.poll(() => element.querySelector("img")?.src).not.toBe(firstUrl);
    await expect.poll(() => element.querySelector("img")?.style.visibility).toBe("visible");
    expect(revoke).toHaveBeenCalledWith(firstUrl);
    const secondUrl = image(element).src;
    element.remove();
    expect(revoke).toHaveBeenCalledWith(secondUrl);
  });

  it("cancels owned animation work when the consumer disposes its component", async () => {
    const definition = atlas();
    if (definition.appearance.kind !== "sprite-atlas") {
      throw new Error("Expected atlas");
    }
    definition.appearance.animations.idle = { frames: [0, 1], fps: 20, loop: true };
    const element = await mount(definition);
    await expect.poll(() => image(element).style.visibility).toBe("visible");
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    element.remove();
    expect(cancel).toHaveBeenCalled();
  });
});
