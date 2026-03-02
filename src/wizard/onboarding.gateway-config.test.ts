import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter, WizardSelectParams } from "./prompts.js";

const mocks = vi.hoisted(() => ({
  randomToken: vi.fn(),
  getTailnetHostname: vi.fn(),
}));

vi.mock("../commands/onboard-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("../commands/onboard-helpers.js")>();
  return {
    ...actual,
    randomToken: mocks.randomToken,
  };
});

vi.mock("../infra/tailscale.js", () => ({
  findTailscaleBinary: vi.fn(async () => undefined),
  getTailnetHostname: mocks.getTailnetHostname,
}));

import { configureGatewayForOnboarding } from "./onboarding.gateway-config.js";

describe("configureGatewayForOnboarding", () => {
  function createPrompter(params: { selectQueue: string[]; textQueue: Array<string | undefined> }) {
    const selectQueue = [...params.selectQueue];
    const textQueue = [...params.textQueue];
    const select = vi.fn(
      async (_params: WizardSelectParams<unknown>) => selectQueue.shift() as unknown,
    ) as unknown as WizardPrompter["select"];

    return buildWizardPrompter({
      select,
      text: vi.fn(async () => textQueue.shift() as string),
    });
  }

  function createRuntime(): RuntimeEnv {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
  }

  function createQuickstartGateway(authMode: "token" | "password") {
    return {
      hasExisting: false,
      port: 18789,
      bind: "loopback" as const,
      authMode,
      tailscaleMode: "off" as const,
      token: undefined,
      password: undefined,
      customBindHost: undefined,
      tailscaleResetOnExit: false,
    };
  }

  async function runGatewayConfig(params?: {
    flow?: "advanced" | "quickstart";
    bindChoice?: string;
    authChoice?: "token" | "password";
    tailscaleChoice?: "off" | "serve";
    textQueue?: Array<string | undefined>;
    nextConfig?: Record<string, unknown>;
  }) {
    const authChoice = params?.authChoice ?? "token";
    const prompter = createPrompter({
      selectQueue: [params?.bindChoice ?? "loopback", authChoice, params?.tailscaleChoice ?? "off"],
      textQueue: params?.textQueue ?? ["18789", undefined],
    });
    const runtime = createRuntime();
    return configureGatewayForOnboarding({
      flow: params?.flow ?? "advanced",
      baseConfig: {},
      nextConfig: params?.nextConfig ?? {},
      localPort: 18789,
      quickstartGateway: createQuickstartGateway(authChoice),
      prompter,
      runtime,
    });
  }

  it("generates a token when the prompt returns undefined", async () => {
    mocks.randomToken.mockReturnValue("generated-token");
    const result = await runGatewayConfig();

    expect(result.settings.gatewayToken).toBe("generated-token");
    expect(result.nextConfig.gateway?.nodes?.denyCommands).toEqual([
      "camera.snap",
      "camera.clip",
      "screen.record",
      "calendar.add",
      "contacts.add",
      "reminders.add",
    ]);
  });

  it("prefers OPENCLAW_GATEWAY_TOKEN during quickstart token setup", async () => {
    const prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "token-from-env";
    mocks.randomToken.mockReturnValue("generated-token");
    mocks.randomToken.mockClear();

    try {
      const result = await runGatewayConfig({
        flow: "quickstart",
        textQueue: [],
      });

      expect(result.settings.gatewayToken).toBe("token-from-env");
    } finally {
      if (prevToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
      }
    }
  });

  it("does not set password to literal 'undefined' when prompt returns undefined", async () => {
    mocks.randomToken.mockReturnValue("unused");
    const result = await runGatewayConfig({
      authChoice: "password",
    });

    const authConfig = result.nextConfig.gateway?.auth as { mode?: string; password?: string };
    expect(authConfig?.mode).toBe("password");
    expect(authConfig?.password).toBe("");
    expect(authConfig?.password).not.toBe("undefined");
  });

  it("seeds control UI allowed origins for non-loopback binds", async () => {
    mocks.randomToken.mockReturnValue("generated-token");
    const result = await runGatewayConfig({
      bindChoice: "lan",
    });

    expect(result.nextConfig.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
    ]);
  });

  it("adds Tailscale origin to controlUi.allowedOrigins when tailscale serve is enabled", async () => {
    mocks.randomToken.mockReturnValue("generated-token");
    mocks.getTailnetHostname.mockResolvedValue("my-host.tail1234.ts.net");
    const result = await runGatewayConfig({
      tailscaleChoice: "serve",
    });

    expect(result.nextConfig.gateway?.controlUi?.allowedOrigins).toContain(
      "https://my-host.tail1234.ts.net",
    );
  });

  it("does not add Tailscale origin when getTailnetHostname fails", async () => {
    mocks.randomToken.mockReturnValue("generated-token");
    mocks.getTailnetHostname.mockRejectedValue(new Error("not found"));
    const result = await runGatewayConfig({
      tailscaleChoice: "serve",
    });

    expect(result.nextConfig.gateway?.controlUi?.allowedOrigins).toBeUndefined();
  });

  it("formats IPv6 Tailscale fallback addresses as valid HTTPS origins", async () => {
    mocks.randomToken.mockReturnValue("generated-token");
    mocks.getTailnetHostname.mockResolvedValue("fd7a:115c:a1e0::99");
    const result = await runGatewayConfig({
      tailscaleChoice: "serve",
    });

    expect(result.nextConfig.gateway?.controlUi?.allowedOrigins).toContain(
      "https://[fd7a:115c:a1e0::99]",
    );
  });

  it("does not duplicate Tailscale origin when allowlist already contains case variants", async () => {
    mocks.randomToken.mockReturnValue("generated-token");
    mocks.getTailnetHostname.mockResolvedValue("my-host.tail1234.ts.net");
    const result = await runGatewayConfig({
      tailscaleChoice: "serve",
      nextConfig: {
        gateway: {
          controlUi: {
            allowedOrigins: ["HTTPS://MY-HOST.TAIL1234.TS.NET"],
          },
        },
      },
    });

    const origins = result.nextConfig.gateway?.controlUi?.allowedOrigins ?? [];
    const tsOriginCount = origins.filter(
      (origin) => origin.toLowerCase() === "https://my-host.tail1234.ts.net",
    ).length;
    expect(tsOriginCount).toBe(1);
  });
});
