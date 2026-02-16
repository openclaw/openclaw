import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  resolveGatewayPort: vi.fn(),
  buildGatewayAuthConfig: vi.fn(),
  note: vi.fn(),
  randomToken: vi.fn(),
}));

vi.mock("../config/config.js", async (importActual) => {
  const actual = await importActual<typeof import("../config/config.js")>();
  return {
    ...actual,
    resolveGatewayPort: mocks.resolveGatewayPort,
  };
});

vi.mock("./configure.shared.js", () => ({
  text: mocks.text,
  select: mocks.select,
  confirm: mocks.confirm,
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

vi.mock("./configure.gateway-auth.js", () => ({
  buildGatewayAuthConfig: mocks.buildGatewayAuthConfig,
}));

vi.mock("../infra/tailscale.js", () => ({
  findTailscaleBinary: vi.fn(async () => undefined),
}));

vi.mock("./onboard-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("./onboard-helpers.js")>();
  return {
    ...actual,
    randomToken: mocks.randomToken,
  };
});

import { promptGatewayConfig } from "./configure.gateway.js";

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

async function runTrustedProxyPrompt(textQueue: Array<string | undefined>) {
  vi.clearAllMocks();
  mocks.resolveGatewayPort.mockReturnValue(18789);
  const selectQueue = ["loopback", "trusted-proxy", "off"];
  mocks.select.mockImplementation(async () => selectQueue.shift());
  mocks.text.mockImplementation(async () => textQueue.shift());
  mocks.buildGatewayAuthConfig.mockImplementation(({ mode, trustedProxy }) => ({
    mode,
    trustedProxy,
  }));

  const result = await promptGatewayConfig({}, makeRuntime());
  const call = mocks.buildGatewayAuthConfig.mock.calls[0]?.[0];
  return { result, call };
}

describe("promptGatewayConfig", () => {
  it("generates a token when the prompt returns undefined", async () => {
    mocks.resolveGatewayPort.mockReturnValue(18789);
    const selectQueue = ["loopback", "token", "off"];
    mocks.select.mockImplementation(async () => selectQueue.shift());
    const textQueue = ["18789", undefined];
    mocks.text.mockImplementation(async () => textQueue.shift());
    mocks.randomToken.mockReturnValue("generated-token");
    mocks.buildGatewayAuthConfig.mockImplementation(({ mode, token, password }) => ({
      mode,
      token,
      password,
    }));

    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const result = await promptGatewayConfig({}, runtime);
    expect(result.token).toBe("generated-token");
  });
  it("does not set password to literal 'undefined' when prompt returns undefined", async () => {
    vi.clearAllMocks();
    mocks.resolveGatewayPort.mockReturnValue(18789);
    // Flow: loopback bind → password auth → tailscale off
    const selectQueue = ["loopback", "password", "off"];
    mocks.select.mockImplementation(async () => selectQueue.shift());
    // Port prompt → OK, then password prompt → returns undefined (simulating prompter edge case)
    const textQueue = ["18789", undefined];
    mocks.text.mockImplementation(async () => textQueue.shift());
    mocks.randomToken.mockReturnValue("unused");
    mocks.buildGatewayAuthConfig.mockImplementation(({ mode, token, password }) => ({
      mode,
      token,
      password,
    }));

    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await promptGatewayConfig({}, runtime);
    const call = mocks.buildGatewayAuthConfig.mock.calls[0]?.[0];
    expect(call?.password).not.toBe("undefined");
    expect(call?.password).toBe("");
  });

  it("prompts for trusted-proxy configuration when trusted-proxy mode selected", async () => {
    const { result, call } = await runTrustedProxyPrompt([
      "18789",
      "x-forwarded-user",
      "x-forwarded-proto,x-forwarded-host",
      "nick@example.com",
      "10.0.1.10,192.168.1.5",
    ]);

    expect(call?.mode).toBe("trusted-proxy");
    expect(call?.trustedProxy).toEqual({
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
      allowUsers: ["nick@example.com"],
    });
    expect(result.config.gateway?.bind).toBe("lan");
    expect(result.config.gateway?.trustedProxies).toEqual(["10.0.1.10", "192.168.1.5"]);
  });

  it("handles trusted-proxy with no optional fields", async () => {
    const { result, call } = await runTrustedProxyPrompt([
      "18789",
      "x-remote-user",
      "",
      "",
      "10.0.0.1",
    ]);

    expect(call?.mode).toBe("trusted-proxy");
    expect(call?.trustedProxy).toEqual({
      userHeader: "x-remote-user",
      // requiredHeaders and allowUsers should be undefined when empty
    });
    expect(result.config.gateway?.bind).toBe("lan");
    expect(result.config.gateway?.trustedProxies).toEqual(["10.0.0.1"]);
  });

  it("forces tailscale off when trusted-proxy is selected", async () => {
    vi.clearAllMocks();
    mocks.resolveGatewayPort.mockReturnValue(18789);
    const selectQueue = ["loopback", "trusted-proxy", "serve"];
    mocks.select.mockImplementation(async () => selectQueue.shift());
    const textQueue = ["18789", "x-forwarded-user", "", "", "10.0.0.1"];
    mocks.text.mockImplementation(async () => textQueue.shift());
    mocks.confirm.mockResolvedValue(true);
    mocks.buildGatewayAuthConfig.mockImplementation(({ mode, trustedProxy }) => ({
      mode,
      trustedProxy,
    }));

    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const result = await promptGatewayConfig({}, runtime);
    expect(result.config.gateway?.bind).toBe("lan");
    expect(result.config.gateway?.tailscale?.mode).toBe("off");
    expect(result.config.gateway?.tailscale?.resetOnExit).toBe(false);
  });
});
