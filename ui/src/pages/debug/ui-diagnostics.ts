// Control UI diagnostics expose a deliberately small, non-sensitive browser snapshot.
import type { ResolvedTheme } from "../../app/theme.ts";

export const UI_DIAGNOSTIC_AREAS = ["runtime", "display", "capabilities", "media"] as const;

export type UiDiagnosticArea = (typeof UI_DIAGNOSTIC_AREAS)[number];
export type UiDiagnosticStatus = "ok" | "warn" | "error" | "unknown";

export type UiDiagnosticId =
  | "runtime.collection"
  | "runtime.surface"
  | "runtime.visibility"
  | "runtime.network"
  | "runtime.secure-context"
  | "runtime.locale"
  | "display.viewport"
  | "display.screen"
  | "display.pixel-ratio"
  | "display.theme"
  | "display.color-scheme"
  | "display.reduced-motion"
  | "capabilities.websocket"
  | "capabilities.webrtc"
  | "capabilities.web-audio"
  | "capabilities.clipboard"
  | "capabilities.media-capture"
  | "capabilities.device-enumeration"
  | "media.device-scan"
  | "media.microphone-inputs";

export type UiDiagnosticValueCode =
  | "unknown"
  | "macos-app"
  | "browser"
  | "visible"
  | "hidden"
  | "online"
  | "offline"
  | "yes"
  | "no"
  | "light"
  | "dark"
  | "enabled"
  | "disabled"
  | "available"
  | "unavailable"
  | "unsupported"
  | "complete"
  | "failed"
  | `theme-${ResolvedTheme}`;

export type UiDiagnosticValue =
  | Readonly<{ kind: "code"; code: UiDiagnosticValueCode }>
  | Readonly<{ kind: "dimensions"; width: number; height: number }>
  | Readonly<{ kind: "locale"; locale: string }>
  | Readonly<{ kind: "decimal"; value: number }>
  | Readonly<{ kind: "count"; value: number }>;

export type UiDiagnosticDetailCode =
  | "no-audio-inputs"
  | "microphone-count-informational"
  | "media-device-enumeration-failed"
  | "media-device-enumeration-timeout"
  | "collection-failed";

export type UiDiagnosticRow = Readonly<{
  id: UiDiagnosticId;
  area: UiDiagnosticArea;
  value: UiDiagnosticValue;
  status: UiDiagnosticStatus;
  detail?: UiDiagnosticDetailCode;
}>;

type UiDiagnosticSurface = "macos-app" | "browser" | "unknown";
type UiDiagnosticVisibility = "visible" | "hidden" | "unknown";
type UiDiagnosticMediaDevice = Readonly<{
  kind: string;
}>;

type UiDiagnosticMediaDevices = Readonly<{
  enumerateDevices: () => Promise<readonly UiDiagnosticMediaDevice[]>;
}>;

export type UiDiagnosticsSource = Readonly<{
  surface: UiDiagnosticSurface;
  visibility: UiDiagnosticVisibility;
  online: boolean | null;
  secureContext: boolean | null;
  locale: string | null;
  viewportWidth: number | null;
  viewportHeight: number | null;
  screenWidth: number | null;
  screenHeight: number | null;
  devicePixelRatio: number | null;
  theme: ResolvedTheme | null;
  prefersLightColorScheme: boolean | null;
  reducedMotion: boolean | null;
  capabilities: Readonly<{
    websocket: boolean;
    webrtc: boolean;
    webAudio: boolean;
    clipboard: boolean;
    mediaCapture: boolean;
    deviceEnumeration: boolean;
  }>;
  mediaDevices: UiDiagnosticMediaDevices | null;
}>;

const RESOLVED_THEMES = new Set<ResolvedTheme>([
  "dark",
  "light",
  "openknot",
  "openknot-light",
  "dash",
  "dash-light",
  "custom",
  "custom-light",
]);
const SHORT_LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/u;
const MEDIA_ENUMERATION_TIMEOUT_MS = 1_500;
const MEDIA_ENUMERATION_TIMEOUT = Symbol("media enumeration timeout");

function safeMediaQuery(query: string): boolean | null {
  if (typeof globalThis.matchMedia !== "function") {
    return null;
  }
  try {
    return globalThis.matchMedia(query).matches;
  } catch {
    return null;
  }
}

function finitePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function knownTheme(value: unknown): ResolvedTheme | null {
  return typeof value === "string" && RESOLVED_THEMES.has(value as ResolvedTheme)
    ? (value as ResolvedTheme)
    : null;
}

function canonicalShortLocale(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 20) {
    return null;
  }
  try {
    const canonical = Intl.getCanonicalLocales(value.trim())[0];
    return canonical && SHORT_LOCALE_PATTERN.test(canonical) ? canonical : null;
  } catch {
    return null;
  }
}

function readBrowserSource(): UiDiagnosticsSource {
  const browserDocument = typeof document === "undefined" ? null : document;
  const browserWindow = typeof window === "undefined" ? null : window;
  const browserNavigator = typeof navigator === "undefined" ? null : navigator;
  const root = browserDocument?.documentElement;

  let mediaDevices: MediaDevices | null = null;
  let clipboard = false;
  try {
    mediaDevices = browserNavigator?.mediaDevices ?? null;
    clipboard = typeof browserNavigator?.clipboard?.writeText === "function";
  } catch {
    // Capability access can throw in restricted webviews; report it as unavailable.
  }

  const visibility = browserDocument?.visibilityState;
  const webAudioGlobal = globalThis as typeof globalThis & { webkitAudioContext?: unknown };
  const deviceEnumeration = typeof mediaDevices?.enumerateDevices === "function";

  return {
    surface: browserDocument
      ? root?.classList.contains("openclaw-native-macos")
        ? "macos-app"
        : "browser"
      : "unknown",
    visibility: visibility === "visible" || visibility === "hidden" ? visibility : "unknown",
    online: typeof browserNavigator?.onLine === "boolean" ? browserNavigator.onLine : null,
    secureContext:
      typeof globalThis.isSecureContext === "boolean" ? globalThis.isSecureContext : null,
    locale: typeof browserNavigator?.language === "string" ? browserNavigator.language : null,
    viewportWidth: finitePositiveNumber(browserWindow?.innerWidth),
    viewportHeight: finitePositiveNumber(browserWindow?.innerHeight),
    screenWidth: finitePositiveNumber(browserWindow?.screen?.width),
    screenHeight: finitePositiveNumber(browserWindow?.screen?.height),
    devicePixelRatio: finitePositiveNumber(browserWindow?.devicePixelRatio),
    theme: knownTheme(root?.dataset.theme),
    prefersLightColorScheme: safeMediaQuery("(prefers-color-scheme: light)"),
    reducedMotion: safeMediaQuery("(prefers-reduced-motion: reduce)"),
    capabilities: {
      websocket: typeof globalThis.WebSocket === "function",
      webrtc: typeof globalThis.RTCPeerConnection === "function",
      webAudio:
        typeof globalThis.AudioContext === "function" ||
        typeof webAudioGlobal.webkitAudioContext === "function",
      clipboard,
      mediaCapture: typeof mediaDevices?.getUserMedia === "function",
      deviceEnumeration,
    },
    mediaDevices: deviceEnumeration ? mediaDevices : null,
  };
}

function codeValue(code: UiDiagnosticValueCode): UiDiagnosticValue {
  return { kind: "code", code };
}

function unknownRow(id: UiDiagnosticId, area: UiDiagnosticArea): UiDiagnosticRow {
  return { id, area, value: codeValue("unknown"), status: "unknown" };
}

function capabilityRow(id: UiDiagnosticId, available: boolean): UiDiagnosticRow {
  return {
    id,
    area: "capabilities",
    value: codeValue(available ? "available" : "unavailable"),
    status: available ? "ok" : "warn",
  };
}

function dimensionsRow(
  id: UiDiagnosticId,
  width: number | null,
  height: number | null,
): UiDiagnosticRow {
  if (width === null || height === null) {
    return unknownRow(id, "display");
  }
  return {
    id,
    area: "display",
    value: { kind: "dimensions", width: Math.round(width), height: Math.round(height) },
    status: "ok",
  };
}

type MediaDiagnostics = Readonly<{
  scan: UiDiagnosticRow;
  microphones: UiDiagnosticRow;
}>;

async function enumerateMediaDevices(
  mediaDevices: UiDiagnosticMediaDevices,
): Promise<readonly UiDiagnosticMediaDevice[]> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = globalThis.setTimeout(
      () => reject(MEDIA_ENUMERATION_TIMEOUT),
      MEDIA_ENUMERATION_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => mediaDevices.enumerateDevices()),
      timeoutPromise,
    ]);
  } finally {
    if (timeout !== undefined) {
      globalThis.clearTimeout(timeout);
    }
  }
}

async function collectMediaDiagnostics(source: UiDiagnosticsSource): Promise<MediaDiagnostics> {
  if (!source.mediaDevices || !source.capabilities.deviceEnumeration) {
    return {
      scan: {
        id: "media.device-scan",
        area: "media",
        value: codeValue("unsupported"),
        status: "warn",
      },
      microphones: unknownRow("media.microphone-inputs", "media"),
    };
  }

  try {
    const devices = await enumerateMediaDevices(source.mediaDevices);
    if (!Array.isArray(devices)) {
      throw new TypeError("invalid media device result");
    }
    const microphoneCount = devices.reduce(
      (count, device) => count + (device?.kind === "audioinput" ? 1 : 0),
      0,
    );
    return {
      scan: {
        id: "media.device-scan",
        area: "media",
        value: codeValue("complete"),
        status: "ok",
      },
      microphones: {
        id: "media.microphone-inputs",
        area: "media",
        value: { kind: "count", value: microphoneCount },
        status: microphoneCount === 0 ? "warn" : "unknown",
        detail: microphoneCount === 0 ? "no-audio-inputs" : "microphone-count-informational",
      },
    };
  } catch (error) {
    return {
      scan: {
        id: "media.device-scan",
        area: "media",
        value: codeValue("failed"),
        status: "error",
        detail:
          error === MEDIA_ENUMERATION_TIMEOUT
            ? "media-device-enumeration-timeout"
            : "media-device-enumeration-failed",
      },
      microphones: unknownRow("media.microphone-inputs", "media"),
    };
  }
}

/**
 * Collects a display-safe diagnostics snapshot. The source contract intentionally
 * excludes URLs, user agents, device identifiers, labels, and application state.
 */
async function collectUiDiagnosticsFromSource(
  source: UiDiagnosticsSource,
): Promise<UiDiagnosticRow[]> {
  const surface: UiDiagnosticRow =
    source.surface === "unknown"
      ? unknownRow("runtime.surface", "runtime")
      : {
          id: "runtime.surface",
          area: "runtime",
          value: codeValue(source.surface),
          status: "ok",
        };
  const visibility: UiDiagnosticRow =
    source.visibility === "unknown"
      ? unknownRow("runtime.visibility", "runtime")
      : {
          id: "runtime.visibility",
          area: "runtime",
          value: codeValue(source.visibility),
          status: source.visibility === "visible" ? "ok" : "warn",
        };
  const network: UiDiagnosticRow =
    source.online === null
      ? unknownRow("runtime.network", "runtime")
      : {
          id: "runtime.network",
          area: "runtime",
          value: codeValue(source.online ? "online" : "offline"),
          status: source.online ? "ok" : "warn",
        };
  const secureContext: UiDiagnosticRow =
    source.secureContext === null
      ? unknownRow("runtime.secure-context", "runtime")
      : {
          id: "runtime.secure-context",
          area: "runtime",
          value: codeValue(source.secureContext ? "yes" : "no"),
          status: source.secureContext ? "ok" : "warn",
        };
  const locale = canonicalShortLocale(source.locale);
  const localeRow: UiDiagnosticRow = locale
    ? {
        id: "runtime.locale",
        area: "runtime",
        value: { kind: "locale", locale },
        status: "ok",
      }
    : unknownRow("runtime.locale", "runtime");

  const normalizedPixelRatio = finitePositiveNumber(source.devicePixelRatio);
  const pixelRatio: UiDiagnosticRow =
    normalizedPixelRatio === null
      ? unknownRow("display.pixel-ratio", "display")
      : {
          id: "display.pixel-ratio",
          area: "display",
          value: { kind: "decimal", value: Math.round(normalizedPixelRatio * 100) / 100 },
          status: "ok",
        };
  const normalizedTheme = knownTheme(source.theme);
  const theme: UiDiagnosticRow = normalizedTheme
    ? {
        id: "display.theme",
        area: "display",
        value: codeValue(`theme-${normalizedTheme}`),
        status: "ok",
      }
    : unknownRow("display.theme", "display");
  const colorScheme: UiDiagnosticRow =
    source.prefersLightColorScheme === null
      ? unknownRow("display.color-scheme", "display")
      : {
          id: "display.color-scheme",
          area: "display",
          value: codeValue(source.prefersLightColorScheme ? "light" : "dark"),
          status: "ok",
        };
  const reducedMotion: UiDiagnosticRow =
    source.reducedMotion === null
      ? unknownRow("display.reduced-motion", "display")
      : {
          id: "display.reduced-motion",
          area: "display",
          value: codeValue(source.reducedMotion ? "enabled" : "disabled"),
          status: "ok",
        };

  const media = await collectMediaDiagnostics(source);
  return [
    surface,
    visibility,
    network,
    secureContext,
    localeRow,
    dimensionsRow("display.viewport", source.viewportWidth, source.viewportHeight),
    dimensionsRow("display.screen", source.screenWidth, source.screenHeight),
    pixelRatio,
    theme,
    colorScheme,
    reducedMotion,
    capabilityRow("capabilities.websocket", source.capabilities.websocket),
    capabilityRow("capabilities.webrtc", source.capabilities.webrtc),
    capabilityRow("capabilities.web-audio", source.capabilities.webAudio),
    capabilityRow("capabilities.clipboard", source.capabilities.clipboard),
    capabilityRow("capabilities.media-capture", source.capabilities.mediaCapture),
    capabilityRow("capabilities.device-enumeration", source.capabilities.deviceEnumeration),
    media.scan,
    media.microphones,
  ];
}

export async function collectUiDiagnostics(
  source?: UiDiagnosticsSource,
): Promise<UiDiagnosticRow[]> {
  try {
    return await collectUiDiagnosticsFromSource(source ?? readBrowserSource());
  } catch {
    return [
      {
        id: "runtime.collection",
        area: "runtime",
        value: codeValue("failed"),
        status: "error",
        detail: "collection-failed",
      },
    ];
  }
}
