import {
  CONTROL_UI_ENVIRONMENT_ATTRIBUTE,
  type ControlUiEnvironment,
} from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { applyControlUiOperatorSeamColor } from "./control-ui-presentation.ts";

export function applyControlUiPresentation(params: {
  environment: ControlUiEnvironment | null;
  seamColor?: string;
}): void {
  applyControlUiOperatorSeamColor(params.seamColor);
  const root = document.documentElement;
  const environment = params.environment;
  if (!environment) {
    const previous = root.getAttribute(CONTROL_UI_ENVIRONMENT_ATTRIBUTE);
    if (previous) {
      const previousEnvironment: ControlUiEnvironment = JSON.parse(previous);
      const suffix = ` · ${previousEnvironment.label}`;
      if (document.title.endsWith(suffix)) {
        document.title = document.title.slice(0, -suffix.length);
      }
    }
    root.removeAttribute(CONTROL_UI_ENVIRONMENT_ATTRIBUTE);
    root.style.removeProperty("--control-ui-environment-color");
    root.style.removeProperty("--control-ui-environment-ink");
    document.querySelector(".control-ui-environment-stripe")?.remove();
    syncControlUiFavicon();
    return;
  }
  root.setAttribute(CONTROL_UI_ENVIRONMENT_ATTRIBUTE, JSON.stringify(environment));
  root.style.setProperty(
    "--control-ui-environment-color",
    `var(--control-ui-environment-${environment.color})`,
  );
  root.style.setProperty(
    "--control-ui-environment-ink",
    `var(--control-ui-environment-${environment.color}-ink)`,
  );
  if (!document.querySelector(".control-ui-environment-stripe")) {
    const stripe = document.createElement("div");
    stripe.className = "control-ui-environment-stripe";
    stripe.setAttribute("aria-hidden", "true");
    document.body.prepend(stripe);
  }
  if (!document.title.endsWith(` · ${environment.label}`)) {
    document.title = `${document.title} · ${environment.label}`;
  }

  syncControlUiFavicon();
}

type ControlUiFaviconStatus = "attention" | "working" | "done" | "disconnected" | "idle";

let faviconStatus: ControlUiFaviconStatus = "idle";
const faviconSources = new Map<string, Promise<FaviconSource>>();
const faviconRequests = new WeakMap<HTMLLinkElement, { signature: string }>();

export function applyControlUiFaviconStatus(status: ControlUiFaviconStatus): void {
  faviconStatus = status;
  syncControlUiFavicon();
}

function restoreFavicon(icon: HTMLLinkElement, original: [string | null, string | null]) {
  for (const [attribute, value] of [
    ["href", original[0]],
    ["type", original[1]],
  ] as const) {
    if (value === null) {
      icon.removeAttribute(attribute);
    } else {
      icon.setAttribute(attribute, value);
    }
  }
}

function syncControlUiFavicon(): void {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const environmentValue = root.getAttribute(CONTROL_UI_ENVIRONMENT_ATTRIBUTE);
  const environment: ControlUiEnvironment | null = environmentValue
    ? JSON.parse(environmentValue)
    : null;
  const environmentColor = environment
    ? style.getPropertyValue(`--control-ui-environment-${environment.color}`).trim()
    : "";
  const environmentSvg = environmentColor
    ? `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path fill="${environmentColor}" d="M60 10C30 10 15 35 15 55c0 20 15 40 30 45v10h10v-10h10v10h10v-10c15-5 30-25 30-45 0-20-15-45-45-45Z"/></svg>`)}`
    : null;
  const light = root.dataset.themeMode === "light";
  const token = {
    attention: light ? "--session-color-orange" : "--warn",
    working: light ? "--info" : "--accent",
    done: "--ok",
    disconnected: "--muted",
    idle: "",
  }[faviconStatus];
  const color = token ? style.getPropertyValue(token).trim() : "";
  const ring = style.getPropertyValue("--bg").trim();
  if (!color) {
    faviconSources.clear();
  }
  for (const icon of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')) {
    if (!environmentSvg && !color) {
      faviconRequests.delete(icon);
      if (icon.dataset.openclawOriginalFavicon) {
        restoreFavicon(icon, JSON.parse(icon.dataset.openclawOriginalFavicon));
        delete icon.dataset.openclawOriginalFavicon;
      }
      continue;
    }
    icon.dataset.openclawOriginalFavicon ??= JSON.stringify([
      icon.getAttribute("href"),
      icon.getAttribute("type"),
    ]);
    const original: [string | null, string | null] = JSON.parse(
      icon.dataset.openclawOriginalFavicon,
    );
    const href = environmentSvg ?? original[0];
    const type = environmentSvg ? "image/svg+xml" : original[1];
    const signature = JSON.stringify([href, type, color, ring]);
    if (faviconRequests.get(icon)?.signature === signature) {
      continue;
    }
    const request = { signature };
    faviconRequests.set(icon, request);
    if (!color || !href) {
      restoreFavicon(icon, [href, type]);
      continue;
    }
    void composeFavicon(href, type, color, ring).then(
      (result) => {
        // Asset decoding may finish after idle, a palette change, or a context teardown.
        if (icon.isConnected && faviconRequests.get(icon) === request) {
          icon.href = result.href;
          icon.type = result.type;
        }
      },
      (error: unknown) => {
        if (faviconRequests.get(icon) === request) {
          faviconRequests.delete(icon);
          restoreFavicon(icon, [href, type]);
          console.warn("[openclaw] favicon status could not be composed", error);
        }
      },
    );
  }
}

type FaviconSource = { svg: Element } | { image: HTMLImageElement };

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

async function loadSource(href: string, type: string | null): Promise<FaviconSource> {
  if (type === "image/svg+xml" || /(?:\.svg(?:[?#]|$)|^data:image\/svg\+xml)/i.test(href)) {
    const response = await fetch(href);
    if (!response.ok) {
      throw new Error(`Favicon loading failed (${response.status})`);
    }
    const parsed = new DOMParser().parseFromString(await response.text(), "image/svg+xml");
    const svg = parsed.documentElement;
    if (
      parsed.querySelector("parsererror") ||
      svg.localName !== "svg" ||
      svg.namespaceURI !== SVG_NAMESPACE
    ) {
      throw new Error("Invalid SVG favicon");
    }
    return { svg };
  }
  const image = new Image();
  image.src = href;
  await image.decode();
  return { image };
}

async function composeFavicon(href: string, type: string | null, color: string, ring: string) {
  const key = JSON.stringify([href, type]);
  let pending = faviconSources.get(key);
  if (!pending) {
    pending = loadSource(href, type);
    faviconSources.set(key, pending);
    void pending.catch(() => {
      if (faviconSources.get(key) === pending) {
        faviconSources.delete(key);
      }
    });
  }
  const source = await pending;
  if ("svg" in source) {
    const svg = new DOMParser().parseFromString(
      `<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 32 32" width="32" height="32"><circle cx="25.5" cy="25.5" r="5" stroke-width="2"/></svg>`,
      "image/svg+xml",
    ).documentElement;
    const dot = svg.firstElementChild!;
    dot.setAttribute("fill", color);
    dot.setAttribute("stroke", ring);
    // Keep SMIL in the favicon document; SVG images cannot load external images.
    const artwork = document.importNode(source.svg, true);
    artwork.setAttribute("x", "0");
    artwork.setAttribute("y", "0");
    artwork.setAttribute("width", "32");
    artwork.setAttribute("height", "32");
    svg.prepend(artwork);
    return {
      href: `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`,
      type: "image/svg+xml",
    };
  }
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Favicon canvas unavailable");
  }
  context.drawImage(source.image, 0, 0, 32, 32);
  context.beginPath();
  context.arc(25.5, 25.5, 5, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
  context.strokeStyle = ring;
  context.lineWidth = 2;
  context.stroke();
  return { href: canvas.toDataURL("image/png"), type: "image/png" };
}
