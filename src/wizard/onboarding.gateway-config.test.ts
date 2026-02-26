import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter, WizardSelectParams } from "./prompts.js";

const mocks = vi.hoisted(() => ({
  randomToken: vi.fn(),
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

  it("generates a token when the prompt returns undefined", async () => {
    mocks.randomToken.mockReturnValue("generated-token");

    const prompter = createPrompter({
      selectQueue: ["loopback", "token", "off"],
      textQueue: ["18789", undefined],
    });
    const runtime = createRuntime();

    const result = await configureGatewayForOnboarding({
      flow: "advanced",
      baseConfig: {},
      nextConfig: {},
      localPort: 18789,
      quickstartGateway: createQuickstartGateway("token"),
      prompter,
      runtime,
    });

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
  it("does not set password to literal 'undefined' when prompt returns undefined", async () => {
    mocks.randomToken.mockReturnValue("unused");

    // Flow: loopback bind → password auth → tailscale off
    const prompter = createPrompter({
      selectQueue: ["loopback", "password", "off"],
      textQueue: ["18789", undefined],
    });
    const runtime = createRuntime();

    const result = await configureGatewayForOnboarding({
      flow: "advanced",
      baseConfig: {},
      nextConfig: {},
      localPort: 18789,
      quickstartGateway: createQuickstartGateway("password"),
      prompter,
      runtime,
    });

    const authConfig = result.nextConfig.gateway?.auth as { mode?: string; password?: string };
    expect(authConfig?.mode).toBe("password");
    expect(authConfig?.password).toBe("");
    expect(authConfig?.password).not.toBe("undefined");
  });

  it("seeds control UI allowed origins for non-loopback binds", async () => {
    mocks.randomToken.mockReturnValue("generated-token");

    const prompter = createPrompter({
      selectQueue: ["lan", "token", "off"],
      textQueue: ["18789", undefined],
    });
    const runtime = createRuntime();

    const result = await configureGatewayForOnboarding({
      flow: "advanced",
      baseConfig: {},
      nextConfig: {},
      localPort: 18789,
      quickstartGateway: createQuickstartGateway("token"),
      prompter,
      runtime,
    });

    expect(result.nextConfig.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
    ]);
  });
});
