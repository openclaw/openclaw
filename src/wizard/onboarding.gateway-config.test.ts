import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { DEFAULT_DANGEROUS_NODE_COMMANDS } from "../gateway/node-command-policy.js";
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
    const select = vi.fn(async (params: WizardSelectParams<unknown>) => {
      const next = selectQueue.shift();
      if (next !== undefined) {
        return next;
      }
      return params.initialValue ?? params.options[0]?.value;
    }) as unknown as WizardPrompter["select"];

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
    expect(result.nextConfig.gateway?.nodes?.denyCommands).toEqual(DEFAULT_DANGEROUS_NODE_COMMANDS);
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

  it("honors secretInputMode=ref for gateway password prompts", async () => {
    const previous = process.env.OPENCLAW_GATEWAY_PASSWORD;
    process.env.OPENCLAW_GATEWAY_PASSWORD = "gateway-secret";
    try {
      const prompter = createPrompter({
        selectQueue: ["loopback", "password", "off", "env"],
        textQueue: ["18789", "OPENCLAW_GATEWAY_PASSWORD"],
      });
      const runtime = createRuntime();

      const result = await configureGatewayForOnboarding({
        flow: "advanced",
        baseConfig: {},
        nextConfig: {},
        localPort: 18789,
        quickstartGateway: createQuickstartGateway("password"),
        secretInputMode: "ref",
        prompter,
        runtime,
      });

      expect(result.nextConfig.gateway?.auth?.mode).toBe("password");
      expect(result.nextConfig.gateway?.auth?.password).toEqual({
        source: "env",
        provider: "default",
        id: "OPENCLAW_GATEWAY_PASSWORD",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PASSWORD;
      } else {
        process.env.OPENCLAW_GATEWAY_PASSWORD = previous;
      }
    }
  });

  it("stores gateway token as SecretRef when secretInputMode=ref", async () => {
    const previous = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "token-from-env";
    try {
      const prompter = createPrompter({
        selectQueue: ["loopback", "token", "off", "env"],
        textQueue: ["18789", "OPENCLAW_GATEWAY_TOKEN"],
      });
      const runtime = createRuntime();

      const result = await configureGatewayForOnboarding({
        flow: "advanced",
        baseConfig: {},
        nextConfig: {},
        localPort: 18789,
        quickstartGateway: createQuickstartGateway("token"),
        secretInputMode: "ref",
        prompter,
        runtime,
      });

      expect(result.nextConfig.gateway?.auth?.mode).toBe("token");
      expect(result.nextConfig.gateway?.auth?.token).toEqual({
        source: "env",
        provider: "default",
        id: "OPENCLAW_GATEWAY_TOKEN",
      });
      expect(result.settings.gatewayToken).toBe("token-from-env");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previous;
      }
    }
  });

  it("resolves quickstart file SecretRefs for gateway token bootstrap", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gw-token-"));
    const tokenFilePath = path.join(tmpDir, "gateway-token.txt");
    fs.writeFileSync(tokenFilePath, "token-from-file\n", { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(tokenFilePath, 0o600);

    try {
      const quickstartGateway = {
        ...createQuickstartGateway("token"),
        token: {
          source: "file" as const,
          provider: "gatewayTokens",
          id: "value",
        },
      };
      const runtime = createRuntime();
      const prompter = createPrompter({
        selectQueue: [],
        textQueue: [],
      });

      const result = await configureGatewayForOnboarding({
        flow: "quickstart",
        baseConfig: {},
        nextConfig: {
          secrets: {
            providers: {
              gatewayTokens: {
                source: "file",
                path: tokenFilePath,
                mode: "singleValue",
              },
            },
          },
        },
        localPort: 18789,
        quickstartGateway,
        prompter,
        runtime,
      });

      expect(result.nextConfig.gateway?.auth?.token).toEqual(quickstartGateway.token);
      expect(result.settings.gatewayToken).toBe("token-from-file");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
