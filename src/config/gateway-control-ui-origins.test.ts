import { describe, expect, it } from "vitest";
import {
  buildDefaultControlUiAllowedOrigins,
  ensureControlUiAllowedOriginsForNonLoopbackBind,
  hasConfiguredControlUiAllowedOrigins,
  isGatewayNonLoopbackBindMode,
  resolveGatewayPortWithDefault,
} from "./gateway-control-ui-origins.js";

describe("isGatewayNonLoopbackBindMode", () => {
  it("returns true for non-loopback bind modes", () => {
    expect(isGatewayNonLoopbackBindMode("lan")).toBe(true);
    expect(isGatewayNonLoopbackBindMode("tailnet")).toBe(true);
    expect(isGatewayNonLoopbackBindMode("custom")).toBe(true);
  });

  it("returns false for loopback and other values", () => {
    expect(isGatewayNonLoopbackBindMode("loopback")).toBe(false);
    expect(isGatewayNonLoopbackBindMode("auto")).toBe(false);
    expect(isGatewayNonLoopbackBindMode(undefined)).toBe(false);
    expect(isGatewayNonLoopbackBindMode(null)).toBe(false);
  });
});

describe("hasConfiguredControlUiAllowedOrigins", () => {
  it("returns true when dangerous fallback is enabled", () => {
    expect(
      hasConfiguredControlUiAllowedOrigins({
        allowedOrigins: [],
        dangerouslyAllowHostHeaderOriginFallback: true,
      }),
    ).toBe(true);
  });

  it("returns true when allowedOrigins has non-empty strings", () => {
    expect(
      hasConfiguredControlUiAllowedOrigins({
        allowedOrigins: ["http://localhost:18789"],
        dangerouslyAllowHostHeaderOriginFallback: false,
      }),
    ).toBe(true);
  });

  it("returns false when allowedOrigins is empty", () => {
    expect(
      hasConfiguredControlUiAllowedOrigins({
        allowedOrigins: [],
        dangerouslyAllowHostHeaderOriginFallback: false,
      }),
    ).toBe(false);
  });

  it("returns false when allowedOrigins contains only whitespace", () => {
    expect(
      hasConfiguredControlUiAllowedOrigins({
        allowedOrigins: ["  ", ""],
        dangerouslyAllowHostHeaderOriginFallback: false,
      }),
    ).toBe(false);
  });
});

describe("resolveGatewayPortWithDefault", () => {
  it("returns the port when it's a positive number", () => {
    expect(resolveGatewayPortWithDefault(19000)).toBe(19000);
    expect(resolveGatewayPortWithDefault(8080)).toBe(8080);
  });

  it("returns the fallback for invalid ports", () => {
    expect(resolveGatewayPortWithDefault(0, 18789)).toBe(18789);
    expect(resolveGatewayPortWithDefault(-1, 18789)).toBe(18789);
    expect(resolveGatewayPortWithDefault(undefined, 18789)).toBe(18789);
    expect(resolveGatewayPortWithDefault(null, 18789)).toBe(18789);
  });
});

describe("buildDefaultControlUiAllowedOrigins", () => {
  it("includes localhost and 127.0.0.1 for standard port", () => {
    const origins = buildDefaultControlUiAllowedOrigins({ port: 18789, bind: "lan" });
    expect(origins).toContain("http://localhost:18789");
    expect(origins).toContain("http://127.0.0.1:18789");
  });

  it("uses custom port in origins", () => {
    const origins = buildDefaultControlUiAllowedOrigins({ port: 19000, bind: "lan" });
    expect(origins).toContain("http://localhost:19000");
    expect(origins).toContain("http://127.0.0.1:19000");
  });

  it("includes custom bind host when bind is custom", () => {
    const origins = buildDefaultControlUiAllowedOrigins({
      port: 18789,
      bind: "custom",
      customBindHost: "192.168.1.100",
    });
    expect(origins).toContain("http://localhost:18789");
    expect(origins).toContain("http://127.0.0.1:18789");
    expect(origins).toContain("http://192.168.1.100:18789");
  });

  it("does not include custom bind host for non-custom bind modes", () => {
    const origins = buildDefaultControlUiAllowedOrigins({
      port: 18789,
      bind: "lan",
      customBindHost: "192.168.1.100",
    });
    expect(origins).not.toContain("http://192.168.1.100:18789");
  });
});

describe("ensureControlUiAllowedOriginsForNonLoopbackBind", () => {
  it("returns null when bind is loopback", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind({
      gateway: { bind: "loopback" },
    });
    expect(result.seededOrigins).toBe(null);
    expect(result.bind).toBe(null);
  });

  it("returns null when allowedOrigins are already configured", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind({
      gateway: {
        bind: "lan",
        controlUi: {
          allowedOrigins: ["http://example.com:18789"],
        },
      },
    });
    expect(result.seededOrigins).toBe(null);
  });

  it("seeds allowedOrigins for lan bind without existing origins", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind({
      gateway: { bind: "lan" },
    });
    expect(result.seededOrigins).not.toBe(null);
    expect(result.bind).toBe("lan");
    expect(result.config.gateway?.controlUi?.allowedOrigins).toContain("http://localhost:18789");
    expect(result.config.gateway?.controlUi?.allowedOrigins).toContain("http://127.0.0.1:18789");
  });

  it("uses bindOverride instead of config bind", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
      {
        gateway: { bind: "loopback" },
      },
      { bindOverride: "lan" },
    );
    expect(result.seededOrigins).not.toBe(null);
    expect(result.bind).toBe("lan");
    expect(result.config.gateway?.controlUi?.allowedOrigins).toContain("http://localhost:18789");
  });

  it("uses defaultPort override for custom ports", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
      {
        gateway: { bind: "lan" },
      },
      { defaultPort: 19000 },
    );
    expect(result.seededOrigins).not.toBe(null);
    expect(result.config.gateway?.controlUi?.allowedOrigins).toContain("http://localhost:19000");
    expect(result.config.gateway?.controlUi?.allowedOrigins).toContain("http://127.0.0.1:19000");
  });

  it("uses both bindOverride and defaultPort together", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
      {
        gateway: { bind: "loopback", port: 18789 },
      },
      { bindOverride: "lan", defaultPort: 19000 },
    );
    expect(result.seededOrigins).not.toBe(null);
    expect(result.bind).toBe("lan");
    expect(result.config.gateway?.controlUi?.allowedOrigins).toContain("http://localhost:19000");
    expect(result.config.gateway?.controlUi?.allowedOrigins).toContain("http://127.0.0.1:19000");
  });

  it("skips seeding when Control UI is explicitly disabled", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
      {
        gateway: {
          bind: "lan",
          controlUi: { enabled: false },
        },
      },
      { requireControlUiEnabled: true },
    );
    expect(result.seededOrigins).toBe(null);
  });

  it("seeds when Control UI is enabled and required", () => {
    const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
      {
        gateway: {
          bind: "lan",
          controlUi: { enabled: true },
        },
      },
      { requireControlUiEnabled: true },
    );
    expect(result.seededOrigins).not.toBe(null);
  });
});
