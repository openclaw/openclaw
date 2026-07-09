// Control UI tests cover debug behavior.
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { collectUiDiagnostics, type UiDiagnosticsSource } from "./ui-diagnostics.ts";
import { renderDebug } from "./view.ts";

type DebugProps = Parameters<typeof renderDebug>[0];

function createProps(overrides: Partial<DebugProps> = {}): DebugProps {
  return {
    loading: false,
    status: null,
    health: null,
    models: [],
    heartbeat: null,
    eventLog: [],
    methods: [],
    callMethod: "",
    callParams: "{}",
    callResult: null,
    callError: null,
    uiDiagnostics: [],
    uiDiagnosticsLoading: false,
    onCallMethodChange: () => undefined,
    onCallParamsChange: () => undefined,
    onRefresh: () => undefined,
    onRefreshUiDiagnostics: () => undefined,
    onCall: () => undefined,
    ...overrides,
  };
}

function normalizedText(element: Element | null | undefined): string | undefined {
  return element?.textContent?.replace(/\s+/gu, " ").trim();
}

describe("renderDebug", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    await i18n.setLocale("en");
    vi.unstubAllGlobals();
  });

  it("keeps the security audit command styled as monospace", async () => {
    await i18n.setLocale("zh-CN");
    const container = document.createElement("div");

    render(
      renderDebug(
        createProps({
          status: {
            securityAudit: {
              summary: {
                critical: 0,
                warn: 1,
                info: 2,
              },
            },
          },
        }),
      ),
      container,
    );

    const command = container.querySelector<HTMLElement>(".callout .mono");
    if (!command) {
      throw new Error("expected debug security audit command");
    }
    const callout = container.querySelector(".callout");
    expect(callout?.className).toBe("callout warn");
    expect(normalizedText(callout)).toBe(
      "安全审计: 1 个警告 · 2 条信息. 运行 openclaw security audit --deep 查看详情。",
    );
    expect(command.textContent).toBe("openclaw security audit --deep");
  });

  it("does not render Invalid Date for Date-invalid event timestamps", () => {
    const container = document.createElement("div");

    render(
      renderDebug(
        createProps({
          eventLog: [
            {
              ts: 8_640_000_000_000_001,
              event: "gateway",
              payload: { ok: true },
            },
          ],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("gateway");
    expect(container.textContent).not.toContain("Invalid Date");
  });

  it("renders ordered UI diagnostics in a semantic table", () => {
    const container = document.createElement("div");

    render(
      renderDebug(
        createProps({
          uiDiagnostics: [
            {
              id: "runtime.surface",
              area: "runtime",
              value: { kind: "code", code: "browser" },
              status: "ok",
            },
            {
              id: "runtime.locale",
              area: "runtime",
              value: { kind: "locale", locale: "en-US" },
              status: "ok",
            },
            {
              id: "display.viewport",
              area: "display",
              value: { kind: "dimensions", width: 1440, height: 900 },
              status: "warn",
            },
            {
              id: "display.pixel-ratio",
              area: "display",
              value: { kind: "decimal", value: 2 },
              status: "ok",
            },
            {
              id: "media.device-scan",
              area: "media",
              value: { kind: "code", code: "failed" },
              status: "error",
              detail: "media-device-enumeration-failed",
            },
            {
              id: "media.microphone-inputs",
              area: "media",
              value: { kind: "count", value: 2 },
              status: "unknown",
              detail: "microphone-count-informational",
            },
          ],
        }),
      ),
      container,
    );

    const table = container.querySelector<HTMLTableElement>(".debug-ui-diagnostics table");
    expect(table).not.toBeNull();
    expect(table?.getAttribute("aria-label")).toBe("UI Diagnostics");
    const card = table?.closest<HTMLElement>(".debug-ui-diagnostics");
    expect(normalizedText(card?.querySelector(".card-sub"))).toBe(
      "Browser surface, display preferences, and media capabilities.",
    );
    expect(normalizedText(card?.querySelector("button"))).toBe("Refresh diagnostics");
    expect([...table!.querySelectorAll("thead th")].map(normalizedText)).toEqual([
      "Area",
      "Signal",
      "Value",
      "Status",
    ]);
    expect(
      [...table!.querySelectorAll("thead th")].map((heading) => heading.getAttribute("scope")),
    ).toEqual(["col", "col", "col", "col"]);
    expect(table?.closest("[aria-busy]")?.getAttribute("aria-busy")).toBe("false");

    const rows = [...table!.querySelectorAll<HTMLTableRowElement>("tbody tr")];
    expect(rows.map((row) => row.dataset.diagnosticId)).toEqual([
      "runtime.surface",
      "runtime.locale",
      "display.viewport",
      "display.pixel-ratio",
      "media.device-scan",
      "media.microphone-inputs",
    ]);
    expect(rows.map(normalizedText)).toEqual([
      "Runtime Surface Web browser OK",
      "Runtime Browser locale en-US OK",
      "Display Viewport 1,440 × 900 Warning",
      "Display Device pixel ratio 2 OK",
      "Media Device scan Failed The browser did not return its media device list. Error",
      "Media Microphone inputs 2 detected Device enumeration does not confirm microphone permission or readability. Unknown",
    ]);
    expect(
      [...table!.querySelectorAll<HTMLTableCellElement>("tbody th")].map(
        (heading) => heading.scope,
      ),
    ).toEqual(Array(6).fill("row"));
    expect(
      rows.map((row) => row.querySelector<HTMLElement>("[data-status]")?.dataset.status),
    ).toEqual(["ok", "ok", "warn", "ok", "error", "unknown"]);
    expect(
      rows.every(
        (row) =>
          row.querySelector(".debug-ui-diagnostics__status-dot")?.getAttribute("aria-hidden") ===
          "true",
      ),
    ).toBe(true);
  });

  it("shows collection progress and disables the UI diagnostics refresh action", () => {
    const container = document.createElement("div");

    render(renderDebug(createProps({ uiDiagnosticsLoading: true })), container);

    const card = container.querySelector<HTMLElement>(".debug-ui-diagnostics");
    const refresh = card?.querySelector<HTMLButtonElement>("button");
    expect(refresh?.disabled).toBe(true);
    expect(normalizedText(refresh)).toBe("Refreshing…");
    expect(normalizedText(card?.querySelector('[role="status"]'))).toBe(
      "Collecting UI diagnostics…",
    );
    expect(card?.querySelector("[aria-busy]")?.getAttribute("aria-busy")).toBe("true");
    expect(normalizedText(card?.querySelector(".data-table-empty-cell"))).toBe(
      "Collecting UI diagnostics…",
    );
  });

  it("does not render media device metadata excluded by the collector", async () => {
    const source: UiDiagnosticsSource = {
      surface: "browser",
      visibility: "visible",
      online: true,
      secureContext: true,
      locale: "en-US",
      viewportWidth: 1280,
      viewportHeight: 720,
      screenWidth: 2560,
      screenHeight: 1440,
      devicePixelRatio: 2,
      theme: "dark",
      prefersLightColorScheme: false,
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
        ],
      },
    };
    const container = document.createElement("div");

    render(
      renderDebug(createProps({ uiDiagnostics: await collectUiDiagnostics(source) })),
      container,
    );

    expect(container.textContent).toContain("1 detected");
    expect(container.outerHTML).not.toContain("CANARY_DEVICE_ID_DO_NOT_RENDER");
    expect(container.outerHTML).not.toContain("CANARY_GROUP_ID_DO_NOT_RENDER");
    expect(container.outerHTML).not.toContain("CANARY_DEVICE_LABEL_DO_NOT_RENDER");
  });
});
