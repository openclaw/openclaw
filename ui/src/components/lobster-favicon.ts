import { render } from "lit";
import { getLobsterdex } from "./lobster-dex.ts";
import { canonicalLobsterLook, lobsterLookStyle, renderLobsterSvg } from "./lobster-pet-look.ts";
import { LOBSTER_PET_PALETTES } from "./lobster-pet-palettes.ts";

// Only presentation used by our trusted lobster artwork is baked. This is not
// an SVG importer: geometry, text and local definitions come from the renderer.
const PRESENTATION_PROPERTIES = [
  "color",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "filter",
  "clip-path",
  "mask",
  "display",
  "visibility",
  "transform",
  "transform-origin",
  "transform-box",
  "shape-rendering",
  "paint-order",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "white-space",
] as const;

/** Lazy artwork boundary; callers retain ownership of selection and composition. */
export async function loadUnlockedLobsterFavicon(
  paletteId: string,
): Promise<HTMLImageElement | null> {
  const palette = LOBSTER_PET_PALETTES.find((entry) => entry.id === paletteId);
  if (!palette || !getLobsterdex().has(paletteId)) {
    return null;
  }

  const host = document.createElement("div");
  try {
    const look = canonicalLobsterLook(palette);
    host.className = "lobster-pet lobster-pet--palette-" + palette.id;
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      lobsterLookStyle(look) +
      ";position:fixed;left:-10000px;top:0;bottom:auto;width:120px;height:105px;opacity:0;pointer-events:none;transform:none";
    document.body.append(host);
    render(renderLobsterSvg(look, { standalone: true }), host);
    const source = host.querySelector("svg");
    if (!source) {
      return null;
    }

    // Use the neutral pose, not a time sample (blink/breathe have seeded delays).
    for (const element of [source, ...source.querySelectorAll<SVGElement>("*")]) {
      element.style.setProperty("animation", "none", "important");
      element.style.setProperty("transition", "none", "important");
    }
    // SAFETY: DOM cloneNode preserves the concrete SVG root type.
    const clone = source.cloneNode(true) as SVGSVGElement;
    const originals = [source, ...source.querySelectorAll<SVGElement>("*")];
    const copies = [clone, ...clone.querySelectorAll<SVGElement>("*")];
    for (const [index, original] of originals.entries()) {
      const copy = copies[index];
      if (!copy) {
        continue;
      }
      const computed = getComputedStyle(original);
      copy.removeAttribute("class");
      copy.removeAttribute("style");
      for (const property of PRESENTATION_PROPERTIES) {
        // Browsers may resolve fragment paint/filter URLs against the page.
        // Keep any definitions inside this standalone SVG, never on that page.
        const value = computed
          .getPropertyValue(property)
          .replace(/url\(["']?[^)"']*#([^)"']+)["']?\)/g, 'url("#$1")');
        copy.style.setProperty(property, value);
      }
    }

    // Some canonical sprites extend past their nominal viewBox (balloon string,
    // retro antennae). Retain them and a small halo, without square stretching.
    const bounds = source.getBBox();
    const viewBox = source.viewBox.baseVal;
    const x = Math.min(viewBox.x, bounds.x) - 4;
    const y = Math.min(viewBox.y, bounds.y) - 4;
    const width = Math.max(viewBox.x + viewBox.width, bounds.x + bounds.width) - x + 4;
    const height = Math.max(viewBox.y + viewBox.height, bounds.y + bounds.height) - y + 4;
    clone.setAttribute("viewBox", [x, y, width, height].join(" "));
    clone.setAttribute("width", String(width));
    clone.setAttribute("height", String(height));
    const image = new Image();
    image.src =
      "data:image/svg+xml;charset=utf-8," +
      encodeURIComponent(new XMLSerializer().serializeToString(clone));
    await image.decode();
    // Clearing the collection during decode must not revive an unavailable pick.
    return getLobsterdex().has(paletteId) ? image : null;
  } catch {
    return null;
  } finally {
    host.remove();
  }
}
