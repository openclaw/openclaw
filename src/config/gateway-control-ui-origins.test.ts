import { describe, expect, it } from "vitest";
import {
  buildDefaultControlUiAllowedOrigins,
  ensureControlUiAllowedOriginsForNonLoopbackBind,
  hasConfiguredControlUiAllowedOrigins,
} from "./gateway-control-ui-origins.js";

describe("buildDefaultControlUiAllowedOrigins", () => {
  it("seeds loopback origins only for non-loopback bind modes", () => {
    expect(
      buildDefaultControlUiAllowedOrigins({
        port: 1455,
        bind: "custom",
        customBindHost: "gateway.example.test",
      }),
    ).toEqual(["http://localhost:1455", "http://127.0.0.1:1455"]);
  });

  it("does not infer LAN or wildcard browser origins from bind mode", () => {
    expect(
      buildDefaultControlUiAllowedOrigins({
        port: 1455,
        bind: "lan",
      }),
    ).not.toContain("http://0.0.0.0:1455");
    expect(
      buildDefaultControlUiAllowedOrigins({
        port: 1455,
        bind: "custom",
        customBindHost: "192.0.2.10",
      }),
    ).not.toContain("http://192.0.2.10:1455");
  });
});

describe("ensureControlUiAllowedOriginsForNonLoopbackBind", () => {
  it("seeds Fly-style runtime bind and port when config is empty", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
      { gateway: {} },
      {
        runtimeBind: "lan",
        runtimePort: 3000,
        isContainerEnvironment: () => false,
      },
    );

    expect(result.bind).toBe("lan");
    expect(result.seededOrigins).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);
    expect(result.config.gateway?.controlUi?.allowedOrigins).toEqual(result.seededOrigins);
  });

  it("uses runtime bind before config bind to match gateway startup precedence", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
      { gateway: { bind: "loopback" } },
      {
        runtimeBind: "lan",
        isContainerEnvironment: () => false,
      },
    );

    expect(result.bind).toBe("lan");
    expect(result.seededOrigins).toContain("http://localhost:18789");
    expect(result.seededOrigins).toContain("http://127.0.0.1:18789");
  });

  it("uses runtime loopback before config non-loopback and avoids seeding", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
      { gateway: { bind: "lan" } },
      {
        runtimeBind: "loopback",
        isContainerEnvironment: () => false,
      },
    );

    expect(result.bind).toBeNull();
    expect(result.seededOrigins).toBeNull();
  });

  it("uses runtime port before config port to match gateway startup precedence", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
      { gateway: { bind: "lan", port: 18789 } },
      {
        runtimePort: 3000,
        isContainerEnvironment: () => false,
      },
    );

    expect(result.seededOrigins).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);
  });

  it("keeps container fallback when runtime and config bind are unset", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
      { gateway: {} },
      { isContainerEnvironment: () => true },
    );

    expect(result.bind).toBe("auto");
    expect(result.seededOrigins).toEqual(["http://localhost:18789", "http://127.0.0.1:18789"]);
  });

  it("does not add custom bind hosts to automatic origins", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind({
      gateway: {
        bind: "custom",
        customBindHost: "gateway.example.test",
        port: 2444,
      },
    });

    expect(result.bind).toBe("custom");
    expect(result.seededOrigins).toEqual(["http://localhost:2444", "http://127.0.0.1:2444"]);
    expect(result.seededOrigins).not.toContain("http://gateway.example.test:2444");
  });

  it("does not overwrite explicit allowed origins", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
      {
        gateway: {
          controlUi: { allowedOrigins: ["https://control.example.com"] },
        },
      },
      {
        runtimeBind: "lan",
        runtimePort: 3000,
        isContainerEnvironment: () => false,
      },
    );

    expect(result.bind).toBe("lan");
    expect(result.seededOrigins).toBeNull();
    expect(result.config.gateway?.controlUi?.allowedOrigins).toEqual([
      "https://control.example.com",
    ]);
  });
});

describe("hasConfiguredControlUiAllowedOrigins", () => {
  it("treats explicit host-header fallback as configured", () => {
    expect(
      hasConfiguredControlUiAllowedOrigins({
        allowedOrigins: [],
        dangerouslyAllowHostHeaderOriginFallback: true,
      }),
    ).toBe(true);
  });

  it("ignores empty origin strings", () => {
    expect(
      hasConfiguredControlUiAllowedOrigins({
        allowedOrigins: ["", "   "],
        dangerouslyAllowHostHeaderOriginFallback: false,
      }),
    ).toBe(false);
  });
});
