import { describe, expect, it } from "vitest";
import {
  combineBrowserStatusDiagnostics,
  deriveBrowserStatusDiagnostics,
  deriveGatewayControlUiDiagnostics,
} from "./status-diagnostics.js";

describe("deriveBrowserStatusDiagnostics", () => {
  it("reports remote HTTP reachability failures", () => {
    expect(
      deriveBrowserStatusDiagnostics({
        running: false,
        cdpReady: false,
        cdpHttp: false,
        cdpPort: 9222,
        cdpUrl: "http://10.0.0.42:9222",
        attachOnly: true,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "ATTACH_ONLY_PROFILE",
          layer: "profile",
          level: "info",
        }),
        expect.objectContaining({
          code: "REMOTE_CDP_HTTP_UNREACHABLE",
          layer: "cdp",
          level: "danger",
          summary: expect.stringContaining("http://10.0.0.42:9222/json/version"),
        }),
      ]),
    );
  });

  it("reports remote websocket readiness separately from HTTP reachability", () => {
    expect(
      deriveBrowserStatusDiagnostics({
        running: false,
        cdpReady: false,
        cdpHttp: true,
        cdpPort: 9222,
        cdpUrl: "https://browser.example:9443?token=abc",
        attachOnly: false,
      }),
    ).toEqual([
      expect.objectContaining({
        code: "REMOTE_CDP_WS_NOT_READY",
        layer: "cdp",
        level: "warn",
      }),
    ]);
  });

  it("reports local relay reachability failures with a local hint", () => {
    expect(
      deriveBrowserStatusDiagnostics({
        running: false,
        cdpReady: false,
        cdpHttp: false,
        cdpPort: 18792,
        cdpUrl: "http://127.0.0.1:18792",
        attachOnly: false,
      }),
    ).toEqual([
      expect.objectContaining({
        code: "LOCAL_CDP_HTTP_UNREACHABLE",
        layer: "cdp",
        level: "warn",
        summary: expect.stringContaining("http://127.0.0.1:18792/json/version"),
      }),
    ]);
  });

  it("returns only attach-only info when CDP is fully ready", () => {
    expect(
      deriveBrowserStatusDiagnostics({
        running: true,
        cdpReady: true,
        cdpHttp: true,
        cdpPort: 9222,
        cdpUrl: "ws://127.0.0.1:9222/devtools/browser/ABC?token=abc",
        attachOnly: true,
      }),
    ).toEqual([
      expect.objectContaining({
        code: "ATTACH_ONLY_PROFILE",
        layer: "profile",
        level: "info",
        hint: expect.stringContaining("http://127.0.0.1:9222/json/version?token=abc"),
      }),
    ]);
  });
});

describe("deriveGatewayControlUiDiagnostics", () => {
  it("flags missing allowedOrigins for non-loopback binds", () => {
    expect(
      deriveGatewayControlUiDiagnostics({
        gateway: {
          bind: "lan",
          port: 18789,
          auth: { mode: "token", token: "[REDACTED]" },
          controlUi: { enabled: true, allowedOrigins: [] },
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "CONTROL_UI_ALLOWED_ORIGINS_REQUIRED",
          layer: "control-ui",
          level: "danger",
        }),
        expect.objectContaining({
          code: "CONTROL_UI_TOKEN_AUTH",
          layer: "control-ui",
          level: "info",
        }),
      ]),
    );
  });

  it("reports loopback-only control-ui access distinctly from CDP errors", () => {
    const diagnostics = combineBrowserStatusDiagnostics(
      deriveGatewayControlUiDiagnostics({
        gateway: {
          bind: "loopback",
          port: 18789,
          auth: { mode: "none" },
          controlUi: { enabled: true },
        },
      }),
      deriveBrowserStatusDiagnostics({
        running: false,
        cdpReady: false,
        cdpHttp: false,
        cdpPort: 9222,
        cdpUrl: "http://10.0.0.42:9222",
        attachOnly: true,
      }),
    );

    expect(diagnostics.map((entry) => entry.code)).toEqual([
      "CONTROL_UI_LOOPBACK_ONLY",
      "CONTROL_UI_AUTH_DISABLED",
      "ATTACH_ONLY_PROFILE",
      "REMOTE_CDP_HTTP_UNREACHABLE",
    ]);
  });
});
