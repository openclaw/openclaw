const PLUGIN_ICON_RASTER_SIZE = 256;
const PLUGIN_ICON_SVG_DECODE_TIMEOUT_MS = 5_000;
const PLUGIN_ICON_SVG_MAX_ELEMENTS = 4;
const PLUGIN_ICON_SVG_MAX_GEOMETRY_CHARS = 8 * 1024;
const PLUGIN_ICON_SVG_MAX_PATH_COMMANDS = 1024;
const PLUGIN_ICON_SVG_MAX_SOURCE_DIMENSION = 4096;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const ALLOWED_SVG_ELEMENTS = new Set([
  "circle",
  "desc",
  "ellipse",
  "g",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "svg",
  "title",
]);
const SVG_COLOR_VALUE_RE = /^(?:none|currentColor|#[0-9a-f]{3,8})$/iu;
const SVG_NUMBER_VALUE_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;
const SVG_NUMBER_LIST_RE = /^[0-9eE+.,\s-]+$/u;
const SVG_PATH_VALUE_RE = /^[0-9a-zA-Z+.,\s-]+$/u;

function parseSvgNumber(value: string): number | null {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:px)?$/iu.test(value.trim())) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSafeSvgAttribute(attribute: Attr): boolean {
  if (attribute.namespaceURI && attribute.name !== "xmlns") {
    return false;
  }
  const value = attribute.value.trim();
  switch (attribute.name) {
    case "d":
      return SVG_PATH_VALUE_RE.test(value);
    case "points":
    case "viewBox":
      return SVG_NUMBER_LIST_RE.test(value);
    case "fill":
    case "stroke":
      return SVG_COLOR_VALUE_RE.test(value);
    case "clip-rule":
    case "fill-rule":
      return /^(?:evenodd|nonzero)$/u.test(value);
    case "stroke-linecap":
      return /^(?:butt|round|square)$/u.test(value);
    case "stroke-linejoin":
      return /^(?:bevel|miter|round)$/u.test(value);
    case "transform":
      return /^(?:\s*(?:matrix|rotate|scale|skewX|skewY|translate)\(\s*[0-9eE+.,\s-]+\)\s*)+$/u.test(
        value,
      );
    case "cx":
    case "cy":
    case "height":
    case "opacity":
    case "r":
    case "rx":
    case "ry":
    case "stroke-miterlimit":
    case "stroke-width":
    case "width":
    case "x":
    case "x1":
    case "x2":
    case "y":
    case "y1":
    case "y2":
      return SVG_NUMBER_VALUE_RE.test(value);
    case "preserveAspectRatio":
      return /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/u.test(value);
    case "xmlns":
      return value === SVG_NAMESPACE;
    case "aria-hidden":
    case "focusable":
      return /^(?:false|true)$/u.test(value);
    case "role":
      return value === "img";
    case "aria-label":
      return /^[^<>&]{0,256}$/u.test(value);
    default:
      return false;
  }
}

async function loadSvgImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      image.src = "";
      reject(new Error("plugin SVG decode timed out"));
    }, PLUGIN_ICON_SVG_DECODE_TIMEOUT_MS);
    image.addEventListener(
      "load",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    image.addEventListener(
      "error",
      () => {
        window.clearTimeout(timeout);
        reject(new Error("plugin SVG decode failed"));
      },
      { once: true },
    );
    image.src = url;
  });
  return image;
}

function parseSvgDimensions(root: Element): { width: number; height: number } | null {
  const viewBox = root.getAttribute("viewBox");
  let width: number | null | undefined;
  let height: number | null | undefined;
  if (viewBox) {
    const values = viewBox
      .trim()
      .split(/[\s,]+/u)
      .map((value) => Number(value));
    if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
      return null;
    }
    width = values[2];
    height = values[3];
  } else {
    width = parseSvgNumber(root.getAttribute("width") ?? "");
    height = parseSvgNumber(root.getAttribute("height") ?? "");
  }
  if (
    !width ||
    !height ||
    width <= 0 ||
    height <= 0 ||
    width > PLUGIN_ICON_SVG_MAX_SOURCE_DIMENSION ||
    height > PLUGIN_ICON_SVG_MAX_SOURCE_DIMENSION
  ) {
    return null;
  }
  return { width, height };
}

async function sanitizeSvgForRasterization(
  blob: Blob,
): Promise<{ blob: Blob; width: number; height: number } | null> {
  const source = await blob.text();
  if (/<!doctype|<!entity/iu.test(source)) {
    return null;
  }
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  if (document.querySelector("parsererror")) {
    return null;
  }
  const root = document.documentElement;
  if (root.namespaceURI !== SVG_NAMESPACE || root.localName !== "svg") {
    return null;
  }
  const elements = [root, ...Array.from(root.querySelectorAll("*"))];
  if (elements.length > PLUGIN_ICON_SVG_MAX_ELEMENTS) {
    return null;
  }
  let geometryChars = 0;
  for (const element of elements) {
    if (
      element.namespaceURI !== SVG_NAMESPACE ||
      !ALLOWED_SVG_ELEMENTS.has(element.localName.toLowerCase())
    ) {
      return null;
    }
    for (const attribute of Array.from(element.attributes)) {
      if (!isSafeSvgAttribute(attribute)) {
        return null;
      }
      if (attribute.name === "d" || attribute.name === "points") {
        geometryChars += attribute.value.length;
      }
    }
  }
  if (geometryChars > PLUGIN_ICON_SVG_MAX_GEOMETRY_CHARS) {
    return null;
  }
  const pathCommands = elements.reduce(
    (count, element) => count + (element.getAttribute("d")?.match(/[a-z]/giu)?.length ?? 0),
    0,
  );
  if (pathCommands > PLUGIN_ICON_SVG_MAX_PATH_COMMANDS) {
    return null;
  }
  const dimensions = parseSvgDimensions(root);
  if (!dimensions) {
    return null;
  }
  return {
    blob: new Blob([new XMLSerializer().serializeToString(root)], { type: "image/svg+xml" }),
    ...dimensions,
  };
}

export async function rasterizeSvg(blob: Blob): Promise<Blob | null> {
  const safe = await sanitizeSvgForRasterization(blob);
  if (!safe) {
    return null;
  }
  const scale = Math.min(
    PLUGIN_ICON_RASTER_SIZE / safe.width,
    PLUGIN_ICON_RASTER_SIZE / safe.height,
  );
  const drawWidth = Math.max(1, Math.round(safe.width * scale));
  const drawHeight = Math.max(1, Math.round(safe.height * scale));
  const url = URL.createObjectURL(safe.blob);
  try {
    const image = await loadSvgImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = PLUGIN_ICON_RASTER_SIZE;
    canvas.height = PLUGIN_ICON_RASTER_SIZE;
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }
    context.drawImage(
      image,
      Math.round((PLUGIN_ICON_RASTER_SIZE - drawWidth) / 2),
      Math.round((PLUGIN_ICON_RASTER_SIZE - drawHeight) / 2),
      drawWidth,
      drawHeight,
    );
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
