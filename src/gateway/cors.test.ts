import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { GatewayHttpCorsConfig } from "../config/types.gateway.js";
import {
  applyCorsHeaders,
  classifyCorsEndpoint,
  type CorsDecision,
  resolveCorsForRequest,
} from "./cors.js";

describe("classifyCorsEndpoint", () => {
  const both = { chatCompletions: true, responses: true, models: true };
  const none = { chatCompletions: false, responses: false, models: false };

  it("POST /v1/chat/completions with chatCompletions enabled", () => {
    expect(classifyCorsEndpoint("POST", "/v1/chat/completions", both)).toBe("chatCompletions");
  });

  it("POST /v1/chat/completions with chatCompletions disabled", () => {
    expect(classifyCorsEndpoint("POST", "/v1/chat/completions", none)).toBeNull();
  });

  it("OPTIONS /v1/chat/completions with chatCompletions enabled (preflight)", () => {
    expect(classifyCorsEndpoint("OPTIONS", "/v1/chat/completions", both)).toBe("chatCompletions");
  });

  it("POST /v1/responses with responses enabled", () => {
    expect(classifyCorsEndpoint("POST", "/v1/responses", both)).toBe("responses");
  });

  it("POST /v1/responses with responses disabled", () => {
    expect(classifyCorsEndpoint("POST", "/v1/responses", none)).toBeNull();
  });

  it("OPTIONS /v1/responses with responses enabled (preflight)", () => {
    expect(classifyCorsEndpoint("OPTIONS", "/v1/responses", both)).toBe("responses");
  });

  it("POST /tools/invoke always covered", () => {
    expect(classifyCorsEndpoint("POST", "/tools/invoke", none)).toBe("toolsInvoke");
  });

  it("OPTIONS /tools/invoke always covered (preflight)", () => {
    expect(classifyCorsEndpoint("OPTIONS", "/tools/invoke", none)).toBe("toolsInvoke");
  });

  it("GET /v1/models with models enabled", () => {
    expect(classifyCorsEndpoint("GET", "/v1/models", both)).toBe("models");
  });

  it("GET /v1/models with models disabled", () => {
    expect(classifyCorsEndpoint("GET", "/v1/models", none)).toBeNull();
  });

  it("GET /v1/models/some-model subpath with models enabled", () => {
    expect(classifyCorsEndpoint("GET", "/v1/models/some-model", both)).toBe("models");
  });

  it("OPTIONS /v1/models with models enabled (preflight)", () => {
    expect(classifyCorsEndpoint("OPTIONS", "/v1/models", both)).toBe("models");
  });

  it("OPTIONS /v1/models with models disabled", () => {
    expect(classifyCorsEndpoint("OPTIONS", "/v1/models", none)).toBeNull();
  });

  it("POST /v1/models wrong method", () => {
    expect(classifyCorsEndpoint("POST", "/v1/models", both)).toBeNull();
  });

  it("GET /hooks/wake not covered", () => {
    expect(classifyCorsEndpoint("GET", "/hooks/wake", both)).toBeNull();
  });

  it("GET /ready not covered", () => {
    expect(classifyCorsEndpoint("GET", "/ready", both)).toBeNull();
  });

  it("GET / not covered", () => {
    expect(classifyCorsEndpoint("GET", "/", both)).toBeNull();
  });

  it("case insensitive method", () => {
    expect(classifyCorsEndpoint("post", "/v1/chat/completions", both)).toBe("chatCompletions");
  });
});

describe("resolveCorsForRequest", () => {
  const enabledConfig: GatewayHttpCorsConfig = {
    enabled: true,
    allowedOrigins: ["https://a.example"],
  };

  it("returns null when config is undefined", () => {
    expect(
      resolveCorsForRequest({
        method: "POST",
        origin: "https://a.example",
        accessControlRequestMethod: undefined,
        endpointKey: "chatCompletions",
        config: undefined,
      }),
    ).toBeNull();
  });

  it("returns null when enabled is false", () => {
    expect(
      resolveCorsForRequest({
        method: "POST",
        origin: "https://a.example",
        accessControlRequestMethod: undefined,
        endpointKey: "chatCompletions",
        config: { enabled: false },
      }),
    ).toBeNull();
  });

  it("returns null when no origin header", () => {
    expect(
      resolveCorsForRequest({
        method: "POST",
        origin: undefined,
        accessControlRequestMethod: undefined,
        endpointKey: "chatCompletions",
        config: enabledConfig,
      }),
    ).toBeNull();
  });

  it("returns null when endpointKey is null", () => {
    expect(
      resolveCorsForRequest({
        method: "POST",
        origin: "https://a.example",
        accessControlRequestMethod: undefined,
        endpointKey: null,
        config: enabledConfig,
      }),
    ).toBeNull();
  });

  it("returns null when origin does not match", () => {
    expect(
      resolveCorsForRequest({
        method: "POST",
        origin: "https://b.example",
        accessControlRequestMethod: undefined,
        endpointKey: "chatCompletions",
        config: enabledConfig,
      }),
    ).toBeNull();
  });

  it("returns decision with echoed origin on match", () => {
    const decision = resolveCorsForRequest({
      method: "POST",
      origin: "https://a.example",
      accessControlRequestMethod: undefined,
      endpointKey: "chatCompletions",
      config: enabledConfig,
    });
    expect(decision).not.toBeNull();
    expect(decision!.allowOrigin).toBe("https://a.example");
    expect(decision!.isPreflight).toBe(false);
    expect(decision!.allowCredentials).toBe(false);
    expect(decision!.allowMethods).toBe("GET, POST, OPTIONS");
  });

  it("wildcard returns * as allowOrigin", () => {
    const decision = resolveCorsForRequest({
      method: "GET",
      origin: "https://any.site",
      accessControlRequestMethod: undefined,
      endpointKey: "models",
      config: { enabled: true, allowedOrigins: ["*"] },
    });
    expect(decision).not.toBeNull();
    expect(decision!.allowOrigin).toBe("*");
    expect(decision!.allowCredentials).toBe(false);
  });

  it("wildcard with explicit allowCredentials false works", () => {
    const decision = resolveCorsForRequest({
      method: "GET",
      origin: "https://any.site",
      accessControlRequestMethod: undefined,
      endpointKey: "models",
      config: { enabled: true, allowedOrigins: ["*"], allowCredentials: false },
    });
    expect(decision).not.toBeNull();
    expect(decision!.allowOrigin).toBe("*");
    expect(decision!.allowCredentials).toBe(false);
  });

  it("preflight when OPTIONS + accessControlRequestMethod present", () => {
    const decision = resolveCorsForRequest({
      method: "OPTIONS",
      origin: "https://a.example",
      accessControlRequestMethod: "POST",
      endpointKey: "chatCompletions",
      config: enabledConfig,
    });
    expect(decision).not.toBeNull();
    expect(decision!.isPreflight).toBe(true);
  });

  it("non-preflight when POST with matching origin", () => {
    const decision = resolveCorsForRequest({
      method: "POST",
      origin: "https://a.example",
      accessControlRequestMethod: undefined,
      endpointKey: "chatCompletions",
      config: enabledConfig,
    });
    expect(decision).not.toBeNull();
    expect(decision!.isPreflight).toBe(false);
  });

  it("allowedHeaders appends to defaults with dedup", () => {
    const decision = resolveCorsForRequest({
      method: "POST",
      origin: "https://a.example",
      accessControlRequestMethod: undefined,
      endpointKey: "chatCompletions",
      config: {
        enabled: true,
        allowedOrigins: ["https://a.example"],
        allowedHeaders: ["X-Custom", "Authorization"],
      },
    });
    expect(decision).not.toBeNull();
    expect(decision!.allowHeaders).toBe("Authorization, Content-Type, X-Request-ID, X-Custom");
  });

  it("exposedHeaders set appears in decision", () => {
    const decision = resolveCorsForRequest({
      method: "POST",
      origin: "https://a.example",
      accessControlRequestMethod: undefined,
      endpointKey: "chatCompletions",
      config: {
        enabled: true,
        allowedOrigins: ["https://a.example"],
        exposedHeaders: ["X-Total-Count", "X-Rate-Limit"],
      },
    });
    expect(decision!.exposeHeaders).toBe("X-Total-Count, X-Rate-Limit");
  });

  it("exposedHeaders empty returns undefined", () => {
    const decision = resolveCorsForRequest({
      method: "POST",
      origin: "https://a.example",
      accessControlRequestMethod: undefined,
      endpointKey: "chatCompletions",
      config: {
        enabled: true,
        allowedOrigins: ["https://a.example"],
        exposedHeaders: [],
      },
    });
    expect(decision!.exposeHeaders).toBeUndefined();
  });

  it("maxAge defaults to 600", () => {
    const decision = resolveCorsForRequest({
      method: "POST",
      origin: "https://a.example",
      accessControlRequestMethod: undefined,
      endpointKey: "chatCompletions",
      config: enabledConfig,
    });
    expect(decision!.maxAge).toBe(600);
  });

  it("custom maxAge honored", () => {
    const decision = resolveCorsForRequest({
      method: "POST",
      origin: "https://a.example",
      accessControlRequestMethod: undefined,
      endpointKey: "chatCompletions",
      config: { ...enabledConfig, maxAge: 3600 },
    });
    expect(decision!.maxAge).toBe(3600);
  });

  it("allowCredentials true with specific origins echoes origin", () => {
    const decision = resolveCorsForRequest({
      method: "POST",
      origin: "https://a.example",
      accessControlRequestMethod: undefined,
      endpointKey: "chatCompletions",
      config: { ...enabledConfig, allowCredentials: true },
    });
    expect(decision!.allowOrigin).toBe("https://a.example");
    expect(decision!.allowCredentials).toBe(true);
  });

  it("allowCredentials true with wildcard forces no credentials", () => {
    const decision = resolveCorsForRequest({
      method: "POST",
      origin: "https://any.site",
      accessControlRequestMethod: undefined,
      endpointKey: "chatCompletions",
      config: { enabled: true, allowedOrigins: ["*"], allowCredentials: true },
    });
    expect(decision!.allowCredentials).toBe(false);
    expect(decision!.allowOrigin).toBe("*");
  });
});

describe("applyCorsHeaders", () => {
  function createMockRes() {
    return { setHeader: vi.fn() } as unknown as ServerResponse;
  }

  const baseDecision: CorsDecision = {
    allowOrigin: "https://a.example",
    allowCredentials: false,
    allowMethods: "GET, POST, OPTIONS",
    allowHeaders: "Authorization, Content-Type, X-Request-ID",
    exposeHeaders: undefined,
    maxAge: 600,
    isPreflight: false,
  };

  it("sets Access-Control-Allow-Origin", () => {
    const res = createMockRes();
    applyCorsHeaders(res, baseDecision);
    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", "https://a.example");
  });

  it("sets Vary: Origin always", () => {
    const res = createMockRes();
    applyCorsHeaders(res, baseDecision);
    expect(res.setHeader).toHaveBeenCalledWith("Vary", "Origin");
  });

  it("sets Access-Control-Allow-Methods", () => {
    const res = createMockRes();
    applyCorsHeaders(res, baseDecision);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS",
    );
  });

  it("sets Allow-Credentials when true", () => {
    const res = createMockRes();
    applyCorsHeaders(res, { ...baseDecision, allowCredentials: true });
    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Credentials", "true");
  });

  it("does not set Allow-Credentials when false", () => {
    const res = createMockRes();
    applyCorsHeaders(res, baseDecision);
    const calls = (res.setHeader as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      calls.find(([name]: string[]) => name === "Access-Control-Allow-Credentials"),
    ).toBeFalsy();
  });

  it("sets Allow-Headers and Max-Age on preflight", () => {
    const res = createMockRes();
    applyCorsHeaders(res, { ...baseDecision, isPreflight: true });
    expect(res.setHeader).toHaveBeenCalledWith(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, X-Request-ID",
    );
    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Max-Age", "600");
  });

  it("does not set Allow-Headers or Max-Age on non-preflight", () => {
    const res = createMockRes();
    applyCorsHeaders(res, baseDecision);
    const calls = (res.setHeader as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.find(([name]: string[]) => name === "Access-Control-Allow-Headers")).toBeFalsy();
    expect(calls.find(([name]: string[]) => name === "Access-Control-Max-Age")).toBeFalsy();
  });

  it("sets Expose-Headers when present", () => {
    const res = createMockRes();
    applyCorsHeaders(res, { ...baseDecision, exposeHeaders: "X-Total-Count" });
    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Expose-Headers", "X-Total-Count");
  });

  it("does not set Expose-Headers when undefined", () => {
    const res = createMockRes();
    applyCorsHeaders(res, baseDecision);
    const calls = (res.setHeader as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.find(([name]: string[]) => name === "Access-Control-Expose-Headers")).toBeFalsy();
  });
});
