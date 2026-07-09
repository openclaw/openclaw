import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectUiDiagnostics,
  type UiDiagnosticStatus,
  type UiDiagnosticsSource,
} from "./ui-diagnostics.ts";

function supportedSource(overrides: Partial<UiDiagnosticsSource> = {}): UiDiagnosticsSource {
  const base: UiDiagnosticsSource = {
    surface: "macos-app",
    visibility: "visible",
    online: true,
    secureContext: true,
    locale: "en-US",
    viewportWidth: 1440,
    viewportHeight: 900,
    screenWidth: 3024,
    screenHeight: 1964,
    devicePixelRatio: 2,
    theme: "dash-light",
    prefersLightColorScheme: true,
    reducedMotion: false,
    capabilities: {
      websocket: true,
      webrtc: true,
      webAudio: true,
      clipboard: true,
      mediaCapture: true,
      deviceEnumeration: true,
    },
    mediaDevices: {
      enumerateDevices: async () => [
        {
          kind: "audioinput",
          deviceId: "CANARY_DEVICE_ID_DO_NOT_RENDER",
          groupId: "CANARY_GROUP_ID_DO_NOT_RENDER",
          label: "CANARY_DEVICE_LABEL_DO_NOT_RENDER",
        } as never,
        { kind: "videoinput" },
      ],
    },
  };
  return { ...base, ...overrides };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("collectUiDiagnostics", () => {
  it("returns semantic allowlisted rows in deterministic group order", async () => {
    const rows = await collectUiDiagnostics(supportedSource());

    expect(rows.map((row) => row.id)).toEqual([
      "runtime.surface",
      "runtime.visibility",
      "runtime.network",
      "runtime.secure-context",
      "runtime.locale",
      "display.viewport",
      "display.screen",
      "display.pixel-ratio",
      "display.theme",
      "display.color-scheme",
      "display.reduced-motion",
      "capabilities.websocket",
      "capabilities.webrtc",
      "capabilities.web-audio",
      "capabilities.clipboard",
      "capabilities.media-capture",
      "capabilities.device-enumeration",
      "media.device-scan",
      "media.microphone-inputs",
    ]);
    expect(rows.map((row) => row.area)).toEqual([
      ...Array(5).fill("runtime"),
      ...Array(6).fill("display"),
      ...Array(6).fill("capabilities"),
      ...Array(2).fill("media"),
    ]);
    expect(rows.map((row) => row.status)).toEqual([...Array(18).fill("ok"), "unknown"]);
    expect(rows.find((row) => row.id === "runtime.locale")?.value).toEqual({
      kind: "locale",
      locale: "en-US",
    });
    expect(rows.find((row) => row.id === "display.viewport")?.value).toEqual({
      kind: "dimensions",
      width: 1440,
      height: 900,
    });
    expect(rows.find((row) => row.id === "display.theme")?.value).toEqual({
      kind: "code",
      code: "theme-dash-light",
    });
    expect(rows.find((row) => row.id === "media.microphone-inputs")?.value).toEqual({
      kind: "count",
      value: 1,
    });
    expect(rows.find((row) => row.id === "media.microphone-inputs")?.detail).toBe(
      "microphone-count-informational",
    );
    expect(rows.every((row) => !("check" in row))).toBe(true);

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("CANARY_DEVICE_ID_DO_NOT_RENDER");
    expect(serialized).not.toContain("CANARY_GROUP_ID_DO_NOT_RENDER");
    expect(serialized).not.toContain("CANARY_DEVICE_LABEL_DO_NOT_RENDER");
  });

  it("reports missing browser APIs without probing them", async () => {
    const rows = await collectUiDiagnostics({
      surface: "unknown",
      visibility: "unknown",
      online: null,
      secureContext: null,
      locale: null,
      viewportWidth: null,
      viewportHeight: null,
      screenWidth: null,
      screenHeight: null,
      devicePixelRatio: null,
      theme: null,
      prefersLightColorScheme: null,
      reducedMotion: null,
      capabilities: {
        websocket: false,
        webrtc: false,
        webAudio: false,
        clipboard: false,
        mediaCapture: false,
        deviceEnumeration: false,
      },
      mediaDevices: null,
    });

    const statuses = Object.fromEntries(rows.map((row) => [row.id, row.status])) as Record<
      string,
      UiDiagnosticStatus
    >;
    expect(statuses).toEqual({
      "runtime.surface": "unknown",
      "runtime.visibility": "unknown",
      "runtime.network": "unknown",
      "runtime.secure-context": "unknown",
      "runtime.locale": "unknown",
      "display.viewport": "unknown",
      "display.screen": "unknown",
      "display.pixel-ratio": "unknown",
      "display.theme": "unknown",
      "display.color-scheme": "unknown",
      "display.reduced-motion": "unknown",
      "capabilities.websocket": "warn",
      "capabilities.webrtc": "warn",
      "capabilities.web-audio": "warn",
      "capabilities.clipboard": "warn",
      "capabilities.media-capture": "warn",
      "capabilities.device-enumeration": "warn",
      "media.device-scan": "warn",
      "media.microphone-inputs": "unknown",
    });
    expect(rows.find((row) => row.id === "media.device-scan")?.value).toEqual({
      kind: "code",
      code: "unsupported",
    });
  });

  it("maps device enumeration failures to a generic safe result", async () => {
    const source = supportedSource({
      mediaDevices: {
        enumerateDevices: async () => {
          throw new Error("CANARY_RAW_MEDIA_ERROR_WITH_TOKEN");
        },
      },
    });

    const rows = await collectUiDiagnostics(source);
    const scan = rows.find((row) => row.id === "media.device-scan");

    expect(scan).toEqual({
      id: "media.device-scan",
      area: "media",
      value: { kind: "code", code: "failed" },
      status: "error",
      detail: "media-device-enumeration-failed",
    });
    expect(rows.find((row) => row.id === "media.microphone-inputs")?.status).toBe("unknown");
    expect(JSON.stringify(rows)).not.toContain("CANARY_RAW_MEDIA_ERROR_WITH_TOKEN");
  });

  it("bounds a never-settling device scan and clears its timer", async () => {
    vi.useFakeTimers();
    const result = collectUiDiagnostics(
      supportedSource({
        mediaDevices: {
          enumerateDevices: () =>
            new Promise(() => {
              // Intentionally never settles so the timeout path owns completion.
            }),
        },
      }),
    );

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_500);
    const rows = await result;

    expect(rows.find((row) => row.id === "media.device-scan")).toEqual({
      id: "media.device-scan",
      area: "media",
      value: { kind: "code", code: "failed" },
      status: "error",
      detail: "media-device-enumeration-timeout",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a zero microphone count as a safe warning", async () => {
    const rows = await collectUiDiagnostics(
      supportedSource({ mediaDevices: { enumerateDevices: async () => [] } }),
    );

    expect(rows.find((row) => row.id === "media.microphone-inputs")).toEqual({
      id: "media.microphone-inputs",
      area: "media",
      value: { kind: "count", value: 0 },
      status: "warn",
      detail: "no-audio-inputs",
    });
  });

  it("canonicalizes short locales and rejects arbitrary valid-looking tags", async () => {
    const canonical = await collectUiDiagnostics(supportedSource({ locale: "EN-us" }));
    const rejected = await collectUiDiagnostics(
      supportedSource({
        locale: "canary-valid-token",
        theme: "CANARY_THEME_WITH_TOKEN" as never,
      }),
    );

    expect(canonical.find((row) => row.id === "runtime.locale")?.value).toEqual({
      kind: "locale",
      locale: "en-US",
    });
    expect(rejected.find((row) => row.id === "runtime.locale")?.status).toBe("unknown");
    expect(rejected.find((row) => row.id === "display.theme")?.status).toBe("unknown");
    expect(JSON.stringify(rejected)).not.toContain("canary-valid-token");
    expect(JSON.stringify(rejected)).not.toContain("CANARY_THEME_WITH_TOKEN");
  });

  it("fails closed when a browser source accessor throws", async () => {
    const source = new Proxy(supportedSource(), {
      get(target, property, receiver) {
        if (property === "surface") {
          throw new Error("CANARY_SOURCE_ACCESS_ERROR_WITH_TOKEN");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const rows = await collectUiDiagnostics(source);

    expect(rows).toEqual([
      {
        id: "runtime.collection",
        area: "runtime",
        value: { kind: "code", code: "failed" },
        status: "error",
        detail: "collection-failed",
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("CANARY_SOURCE_ACCESS_ERROR_WITH_TOKEN");
  });
});
