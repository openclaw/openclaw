import { describe, expect, it } from "vitest";
import {
  buildDefaultControlUiAllowedOrigins,
  ensureControlUiAllowedOriginsForNonLoopbackBind,
  hasConfiguredControlUiAllowedOrigins,
  isGatewayNonLoopbackBindMode,
} from "./gateway-control-ui-origins.js";

describe("isGatewayNonLoopbackBindMode", () => {
  it.each(["lan", "tailnet", "custom", "auto"] as const)("returns true for %s", (mode) => {
    expect(isGatewayNonLoopbackBindMode(mode)).toBe(true);
  });

  it.each(["loopback", undefined, null, "", "unknown"] as unknown[])(
    "returns false for %s",
    (mode) => {
      expect(isGatewayNonLoopbackBindMode(mode)).toBe(false);
    },
  );
});

describe("hasConfiguredControlUiAllowedOrigins", () => {
  it("returns true when dangerouslyAllowHostHeaderOriginFallback is true", () => {
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
        allowedOrigins: ["http://localhost:3000"],
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
});

describe("buildDefaultControlUiAllowedOrigins", () => {
  it("includes localhost and 127.0.0.1 with the given port", () => {
    const origins = buildDefaultControlUiAllowedOrigins({ port: 3000, bind: "lan" });
    expect(origins).toContain("http://localhost:3000");
    expect(origins).toContain("http://127.0.0.1:3000");
  });

  it("includes custom bind host for custom mode", () => {
    const origins = buildDefaultControlUiAllowedOrigins({
      port: 3000,
      bind: "custom",
      customBindHost: "192.168.1.100",
    });
    expect(origins).toContain("http://192.168.1.100:3000");
  });
});

describe("ensureControlUiAllowedOriginsForNonLoopbackBind", () => {
  describe("effectiveBind parameter", () => {
    it("seeds origins when effectiveBind is lan and config has no bind (Fly.io scenario)", () => {
      const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
        { gateway: {} },
        {
          effectiveBind: "lan",
          isContainerEnvironment: () => false,
        },
      );
      expect(result.seededOrigins).not.toBeNull();
      expect(result.seededOrigins).toContain("http://localhost:18789");
      expect(result.bind).toBe("lan");
    });

    it("seeds origins with effectivePort when config has no port", () => {
      const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
        { gateway: {} },
        {
          effectiveBind: "lan",
          effectivePort: 3000,
          isContainerEnvironment: () => false,
        },
      );
      expect(result.seededOrigins).not.toBeNull();
      expect(result.seededOrigins).toContain("http://localhost:3000");
      expect(result.seededOrigins).toContain("http://127.0.0.1:3000");
    });

    it("does not seed when effectiveBind is loopback", () => {
      const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
        { gateway: {} },
        {
          effectiveBind: "loopback",
          isContainerEnvironment: () => false,
        },
      );
      expect(result.seededOrigins).toBeNull();
      expect(result.bind).toBeNull();
    });

    it("does not seed when neither effectiveBind nor config bind is set and not in container", () => {
      const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
        { gateway: {} },
        { isContainerEnvironment: () => false },
      );
      expect(result.seededOrigins).toBeNull();
      expect(result.bind).toBeNull();
    });

    it("prefers config bind over effectiveBind", () => {
      const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
        { gateway: { bind: "lan" } },
        { effectiveBind: "auto", isContainerEnvironment: () => false },
      );
      expect(result.seededOrigins).not.toBeNull();
      expect(result.bind).toBe("lan");
    });

    it("seeds origins when effectiveBind is auto and container detection returns false", () => {
      const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
        { gateway: {} },
        {
          effectiveBind: "auto",
          isContainerEnvironment: () => false,
        },
      );
      expect(result.seededOrigins).not.toBeNull();
      expect(result.bind).toBe("auto");
    });
  });

  describe("container detection fallback", () => {
    it("seeds origins when config bind is unset and container is detected", () => {
      const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
        { gateway: {} },
        { isContainerEnvironment: () => true },
      );
      expect(result.seededOrigins).not.toBeNull();
      expect(result.bind).toBe("auto");
    });

    it("does not seed when config bind is unset and not in container", () => {
      const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
        { gateway: {} },
        { isContainerEnvironment: () => false },
      );
      expect(result.seededOrigins).toBeNull();
    });
  });

  describe("already configured", () => {
    it("does not seed when allowedOrigins is already set", () => {
      const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
        { gateway: { bind: "lan", controlUi: { allowedOrigins: ["https://example.com"] } } },
        {},
      );
      expect(result.seededOrigins).toBeNull();
      expect(result.bind).toBe("lan");
    });

    it("does not seed when dangerouslyAllowHostHeaderOriginFallback is true", () => {
      const result = ensureControlUiAllowedOriginsForNonLoopbackBind(
        {
          gateway: {
            bind: "lan",
            controlUi: { dangerouslyAllowHostHeaderOriginFallback: true },
          },
        },
        {},
      );
      expect(result.seededOrigins).toBeNull();
    });
  });
});
