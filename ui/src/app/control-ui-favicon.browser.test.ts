import { afterEach, beforeAll, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { commands } from "vitest/browser";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { createAgentSelectionCapability } from "./agent-selection.ts";
import { bindControlUiDocumentHead } from "./control-ui-document-head.ts";
import {
  applyControlUiFaviconImage,
  applyControlUiFaviconStatus,
  applyControlUiPresentation,
} from "./control-ui-environment-presentation.runtime.ts";
import { connectControlUiFavicon } from "./control-ui-favicon-status.runtime.ts";
import { client, createGatewayHarness } from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";
import { currentThemeBranding, setCurrentThemeBranding } from "./theme-branding.ts";

let faviconSvg: string;
beforeAll(async () => {
  // Vitest serves its own /favicon.svg; load the shipped asset from the UI root.
  faviconSvg = await commands.readFile("public/favicon.svg", "utf8");
});

let previousIcons: HTMLLinkElement[];
let previousTitle: string;
const root = document.documentElement;
let previousAttributes: Array<[string, string | null]>;
let previousBranding: ReturnType<typeof currentThemeBranding>;
let svgIcon: HTMLLinkElement;
let pngIcon: HTMLLinkElement;
let originals: [[string, string], [string, string]];

function mascot(value: "claw" | "none") {
  setCurrentThemeBranding(resolveThemeBranding({ mascot: value, critters: [] }));
  root.dataset.themeMascot = value;
}
const dotColor = () => svgDocument().documentElement.lastElementChild?.getAttribute("fill");
const environmentPath = () => svgDocument().querySelector('path[fill="rgb(40, 100, 180)"]');
const animations = (svg = svgDocument()) =>
  Array.from(svg.querySelectorAll("animate, animateTransform"), (animation) =>
    new XMLSerializer().serializeToString(animation),
  );
const painted = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
const subscribe = () => () => {};

beforeEach(() => {
  previousIcons = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]'));
  previousIcons.forEach((icon) => icon.remove());
  previousTitle = document.title;
  previousAttributes = ["style", "data-theme", "data-theme-mode", "data-theme-mascot"].map(
    (name) => [name, root.getAttribute(name)],
  );
  previousBranding = currentThemeBranding();
  root.dataset.theme = "dark";
  root.dataset.themeMode = "dark";
  mascot("claw");
  for (const [name, value] of [
    ["--warn", "rgb(210, 150, 60)"],
    ["--accent", "rgb(80, 120, 160)"],
    ["--ok", "rgb(100, 180, 120)"],
    ["--muted", "rgb(130, 130, 130)"],
    ["--bg", "rgb(240, 240, 240)"],
    ["--control-ui-environment-blue", "rgb(40, 100, 180)"],
  ] as const) {
    root.style.setProperty(name, value);
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  originals = [
    [`data:image/svg+xml,${encodeURIComponent(faviconSvg)}`, "image/svg+xml"],
    [canvas.toDataURL("image/png"), "image/png"],
  ];
  const createIcon = ([href, type]: [string, string]) => {
    const icon = document.createElement("link");
    icon.rel = "icon";
    icon.setAttribute("href", href);
    icon.setAttribute("type", type);
    document.head.append(icon);
    return icon;
  };
  svgIcon = createIcon(originals[0]);
  pngIcon = createIcon(originals[1]);
  bindControlUiDocumentHead({ themeColors: [], favicons: [svgIcon, pngIcon] });
});

afterEach(() => {
  mascot("claw");
  applyControlUiFaviconImage(null);
  applyControlUiFaviconStatus("idle");
  applyControlUiPresentation({ environment: null });
  bindControlUiDocumentHead({ themeColors: [], favicons: [] });
  svgIcon.remove();
  pngIcon.remove();
  document.head.append(...previousIcons);
  document.title = previousTitle;
  for (const [name, value] of previousAttributes) {
    if (value === null) {
      root.removeAttribute(name);
    } else {
      root.setAttribute(name, value);
    }
  }
  setCurrentThemeBranding(previousBranding);
  vi.restoreAllMocks();
});

it("keeps personal artwork SVG-preferred without cropping or changing its status colors", async () => {
  const personal = await artwork();
  const decode = vi.spyOn(HTMLImageElement.prototype, "decode");
  applyControlUiFaviconImage(personal);
  applyControlUiPresentation({
    environment: { label: "Preview", color: "blue" },
    seamColor: "#5078a0",
  });
  await Promise.resolve();
  const idleHref = svgIcon.href;
  // Firefox prefers any queued SVG candidate over a newer PNG, including a
  // default restored briefly while personal artwork is being decoded.
  expect(idleHref).toMatch(/^data:image\/svg\+xml,/u);
  expect([svgIcon.type, pngIcon.type]).toEqual(["image/svg+xml", "image/svg+xml"]);
  expect(decode).not.toHaveBeenCalled();
  const drawing = drawingContext();
  for (const [status, dot] of [
    ["working", [80, 120, 160]],
    ["attention", [210, 150, 60]],
    ["done", [100, 180, 120]],
    ["disconnected", [130, 130, 130]],
  ] as const) {
    decode.mockClear();
    await changePresentation(() => applyControlUiFaviconStatus(status));
    expect(decode).not.toHaveBeenCalled();
    const image = await imageFrom(svgIcon.href);
    drawing.clearRect(0, 0, 32, 32);
    drawing.drawImage(image, 0, 0);
    expect([...drawing.getImageData(8, 12, 1, 1).data]).toEqual([180, 40, 110, 255]);
    expect(drawing.getImageData(16, 1, 1, 1).data[3]).toBe(0);
    expect([...drawing.getImageData(25, 25, 1, 1).data]).toEqual([...dot, 255]);
    expect(pngIcon.href).toBe(svgIcon.href);
  }
  applyControlUiFaviconStatus("idle");
  await Promise.resolve();
  expect(svgIcon.href).toBe(idleHref);
  applyControlUiFaviconImage(null);
  expect(environmentPath()).not.toBeNull();
  applyControlUiPresentation({ environment: null });
  expectOriginals();
});

it("clips avatar shapes without clipping status dots and replaces same-image shapes", async () => {
  const personal = await artwork();
  const drawing = drawingContext();
  const pixels = async () => {
    await Promise.resolve();
    const result = await imageFrom(svgIcon.href);
    drawing.clearRect(0, 0, 32, 32);
    drawing.drawImage(result, 0, 0);
    expect(pngIcon.href).toBe(svgIcon.href);
    return (x: number, y: number) => [...drawing.getImageData(x, y, 1, 1).data];
  };
  for (const shape of ["rounded", "circle", "square"] as const) {
    applyControlUiFaviconImage(personal, shape);
    applyControlUiFaviconStatus("idle");
    const pixel = await pixels();
    expect(pixel(16, 16)).toEqual([180, 40, 110, 255]);
    expect(pixel(0, 0)[3]).toBe(0);
    expect(pixel(16, 1)[3]).toBe(shape === "square" ? 0 : 255);
    expect(pixel(3, 3)[3]).toBe(shape === "rounded" ? 255 : 0);
    applyControlUiFaviconStatus("working");
    const activePixel = await pixels();
    expect(activePixel(25, 25)).toEqual([80, 120, 160, 255]);
    expect(activePixel(27, 27)).toEqual([80, 120, 160, 255]);
  }
  applyControlUiFaviconImage(null);
  applyControlUiFaviconStatus("idle");
  expectOriginals();
});

async function imageFrom(src: string) {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
}
async function artwork() {
  return imageFrom(
    `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="rgb(180,40,110)"/></svg>')}`,
  );
}
function drawingContext() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  return canvas.getContext("2d")!;
}
function expectSvg(selector: string, attribute: string, value: string) {
  expect(svgDocument().querySelector(selector)?.getAttribute(attribute)).toBe(value);
}
function expectMark(fill: string, stroke: string) {
  expectSvg("rect", "fill", fill);
  expectSvg("path", "stroke", stroke);
}

async function changePresentation(change: () => void) {
  const changed = createDeferred();
  const observer = new MutationObserver(() => changed.resolve());
  observer.observe(svgIcon, { attributes: true, attributeFilter: ["href"] });
  try {
    change();
    await changed.promise;
  } finally {
    observer.disconnect();
  }
}

function expectOriginals() {
  [svgIcon, pngIcon].forEach((icon, index) => {
    expect([icon.getAttribute("href"), icon.getAttribute("type")]).toEqual(originals[index]);
    expect(icon.hasAttribute("data-openclaw-original-favicon")).toBe(false);
  });
}

function svgDocument() {
  return new DOMParser().parseFromString(
    decodeURIComponent(svgIcon.href.slice("data:image/svg+xml,".length)),
    "image/svg+xml",
  );
}

it("reuses palette reads through session publications while retaining retries and presentation changes", async () => {
  let row: GatewaySessionRow = {
    key: "agent:main:favicon-palette",
    sessionId: "favicon-palette",
    kind: "direct",
    agentId: "main",
    status: "running",
    hasActiveRun: true,
    activeRunIds: ["favicon-run"],
    updatedAt: 1,
  };
  const harness = createGatewayHarness(
    client(async (method) => {
      if (method === "sessions.list") {
        return sessionsResult([row], 1);
      }
      throw new Error(`Unexpected favicon fixture request: ${method}`);
    }),
  );
  harness.update({ hello: gatewayHelloForMethods(["sessions.list"], ["operator.read"]) });
  const selection = createAgentSelectionCapability(harness.gateway, {
    state: { agentsList: null },
    subscribe,
  });
  const sessions = createSessionCapability(harness.gateway, selection);
  const overlays = createApplicationOverlays(harness.gateway);
  const shell = document.createElement("div");
  document.body.append(shell);
  let disconnect: (() => void) | undefined;
  const notified = vi.fn();
  const stopNotifications = sessions.subscribe(notified);
  const publishRow = (patch: Partial<GatewaySessionRow>) => {
    row = { ...row, ...patch, updatedAt: (row.updatedAt ?? 0) + 1 };
    expect(sessions.captureReconcile()(row, undefined, { resultAgentId: "main" })).toBe(true);
  };
  const expectDot = (color: string) => vi.waitFor(() => expect(dotColor()).toBe(color));

  const themeStyle = document.createElement("style");
  themeStyle.textContent = `
    :root { --primary: rgb(180, 20, 40); --primary-foreground: rgb(250, 250, 250); }
    :root[data-theme="favicon-neutral"] { --primary: rgb(190, 30, 50); --primary-foreground: rgb(240, 240, 240); }
  `;
  document.head.append(themeStyle);
  try {
    await sessions.refresh({ agentId: "main", force: true });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Transient favicon read"));
    disconnect = connectControlUiFavicon(
      shell,
      {
        gateway: harness.gateway,
        agentSelection: selection,
        sessions,
        overlays,
        theme: {
          settings: {},
          get branding() {
            return currentThemeBranding();
          },
          subscribe,
        },
        agents: { state: { agentsList: null }, subscribe: () => () => {} },
        agentIdentity: {
          get: () => null,
          ensure: async () => {},
          subscribe,
        },
      },
      () => [],
    );
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    const styleReads = vi.spyOn(globalThis, "getComputedStyle");
    publishRow({ label: "Retry the failed icon on the next session publication" });
    expect(styleReads).not.toHaveBeenCalled();
    await expectDot("rgb(80, 120, 160)");
    const workingHref = svgIcon.href;
    notified.mockClear();
    styleReads.mockClear();
    for (const label of [
      "First metadata update",
      "Second metadata update",
      "Third metadata update",
    ]) {
      publishRow({ label });
    }
    expect(notified).toHaveBeenCalledTimes(3);
    expect(sessions.state.result?.sessions[0]?.label).toBe("Third metadata update");
    expect(styleReads).not.toHaveBeenCalled();
    expect(svgIcon.href).toBe(workingHref);

    root.style.setProperty("--accent", "rgb(70, 140, 190)");
    await expectDot("rgb(70, 140, 190)");
    root.style.setProperty("--info", "rgb(20, 100, 180)");
    root.dataset.theme = "light";
    root.dataset.themeMode = "light";
    await expectDot("rgb(20, 100, 180)");
    applyControlUiPresentation({ environment: { label: "Preview", color: "blue" } });
    await vi.waitFor(() => expect(environmentPath()).not.toBeNull());
    await expectDot("rgb(20, 100, 180)");
    await changePresentation(() => mascot("none"));
    expectMark("rgb(180, 20, 40)", "rgb(250, 250, 250)");
    expect(environmentPath()).toBeNull();
    expect(dotColor()).toBe("rgb(20, 100, 180)");
    await changePresentation(() => {
      root.dataset.theme = "favicon-neutral";
    });
    expectMark("rgb(190, 30, 50)", "rgb(240, 240, 240)");
    await changePresentation(() => {
      root.style.setProperty("--primary", "rgb(160, 40, 60)");
    });
    expectSvg("rect", "fill", "rgb(160, 40, 60)");
    await changePresentation(() => mascot("claw"));
    expect(environmentPath()).not.toBeNull();
    applyControlUiPresentation({ environment: null });
    await vi.waitFor(() => expect(animations().length).toBeGreaterThan(0));
    await expectDot("rgb(20, 100, 180)");
    publishRow({ status: "failed", hasActiveRun: false, activeRunIds: [] });
    expectOriginals();
    await changePresentation(() => mascot("none"));
    expectSvg("rect", "fill", "rgb(190, 30, 50)");
    expect(svgDocument().querySelector("circle")).toBeNull();
    expect(pngIcon.href).toBe(svgIcon.href);
    await changePresentation(() => mascot("claw"));
    expectOriginals();
  } finally {
    disconnect?.();
    stopNotifications();
    overlays.dispose();
    sessions.dispose();
    selection.dispose();
    shell.remove();
    themeStyle.remove();
  }
});

it("updates both icon formats and restores their exact originals when idle without changing the title", async () => {
  const unrelatedIcon = document.createElement("link");
  unrelatedIcon.rel = "icon";
  unrelatedIcon.href = "/unrelated.svg";
  document.head.append(unrelatedIcon);
  onTestFinished(() => unrelatedIcon.remove());
  applyControlUiFaviconStatus("working");
  await vi.waitFor(() => {
    for (const [icon, [href, type]] of [
      [svgIcon, originals[0]],
      [pngIcon, originals[1]],
    ] as const) {
      expect(icon.getAttribute("href")).not.toBe(href);
      expect(icon.type).toBe(type);
    }
  });
  for (const icon of [svgIcon, pngIcon]) {
    const image = await imageFrom(icon.href);
    expect(image.naturalWidth).toBe(32);
  }
  const original = new DOMParser().parseFromString(faviconSvg, "image/svg+xml");
  expect(animations(svgDocument())).toEqual(animations(original));
  expect(animations(original).length).toBeGreaterThan(0);
  expect(document.title).toBe(previousTitle);
  expect(unrelatedIcon.getAttribute("href")).toBe("/unrelated.svg");
  applyControlUiFaviconStatus("idle");
  expectOriginals();
});

it("keeps the original links when SVG and PNG sources cannot be decoded", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  svgIcon.href = "data:image/svg+xml,invalid";
  pngIcon.href = "data:image/png,invalid";
  applyControlUiFaviconStatus("working");
  await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(2));
  expect(svgIcon.href).toBe("data:image/svg+xml,invalid");
  expect(pngIcon.href).toBe("data:image/png,invalid");
});

it("preserves each active presentation when the environment or status is independently removed", async () => {
  const environment = { label: "Preview", color: "blue" } as const;
  applyControlUiPresentation({ environment });
  const environmentHref = svgIcon.href;
  applyControlUiFaviconStatus("attention");
  await vi.waitFor(() => {
    expect(svgIcon.href).not.toBe(environmentHref);
    expect(dotColor()).toBe("rgb(210, 150, 60)");
  });
  const environmentWithStatus = svgIcon.href;
  applyControlUiPresentation({ environment: null });
  await vi.waitFor(() => {
    expect(svgIcon.href).not.toBe(environmentWithStatus);
    expect(animations().length).toBeGreaterThan(0);
    expect(dotColor()).toBe("rgb(210, 150, 60)");
    expect(pngIcon.type).toBe("image/png");
  });
  applyControlUiPresentation({ environment });
  applyControlUiFaviconStatus("idle");
  expect(svgIcon.href).toBe(environmentHref);
  expect(pngIcon.href).toBe(environmentHref);
  expect(svgIcon.hasAttribute("data-openclaw-original-favicon")).toBe(true);
  applyControlUiPresentation({ environment: null });
  expectOriginals();
});

it.each(["resolve", "reject", "idle"])(
  "ignores retired SVG composition after %s",
  async (settlement) => {
    const earlier = createDeferred<Response>();
    const current = createDeferred<Response>();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(earlier.promise)
      .mockReturnValueOnce(current.promise);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    applyControlUiFaviconStatus("attention");
    expect(fetchSpy).toHaveBeenCalled();
    applyControlUiFaviconStatus("idle");
    let currentHref = svgIcon.href;
    if (settlement !== "idle") {
      applyControlUiFaviconStatus("attention");
      current.resolve(new Response(faviconSvg.replace("<svg", '<svg data-generation="current"')));
      await vi.waitFor(() =>
        expect(svgDocument().querySelector('[data-generation="current"]')).not.toBeNull(),
      );
      currentHref = svgIcon.href;
    }
    if (settlement === "reject") {
      earlier.reject(new Error("Earlier asset request failed"));
    } else {
      earlier.resolve(new Response(faviconSvg, { headers: { "Content-Type": "image/svg+xml" } }));
    }
    await earlier.promise.catch(() => undefined);
    await painted();
    if (settlement === "idle") {
      expectOriginals();
    } else {
      expect(svgIcon.href).toBe(currentHref);
    }
  },
);
