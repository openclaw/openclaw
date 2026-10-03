// Setup gateway config tests cover gateway prompt choices and config output.
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import {
  withSecureTestNodeCommand,
  withSecureTestNodeExecPath,
} from "../secrets/test-node-command.test-support.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
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

import { configureGatewayForSetup } from "./setup.gateway-config.js";
import { resolveQuickstartGatewayDefaults } from "./setup.shared.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseAsync());

describe("configureGatewayForSetup", () => {
  function createPrompter(params: { selectQueue: string[]; textQueue: Array<string | undefined> }) {
    const selectQueue = [...params.selectQueue];
    const textQueue = [...params.textQueue];
    const select = vi.fn(async (paramsLocal: WizardSelectParams<unknown>) => {
      const next = selectQueue.shift();
      if (next !== undefined) {
        return next;
      }
      return paramsLocal.initialValue ?? paramsLocal.options[0]?.value;
    }) as unknown as WizardPrompter["select"];

    return buildWizardPrompter({
      select,
      text: vi.fn(async (paramsLocal) => {
        const hasQueuedValue = textQueue.length > 0;
        const value = hasQueuedValue ? textQueue.shift() : paramsLocal.initialValue;
        const error = typeof value === "string" ? paramsLocal.validate?.(value) : undefined;
        if (error) {
          throw new Error(error);
        }
        return value;
      }),
    });
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
    };
  }

  function configure(overrides: Partial<Parameters<typeof configureGatewayForSetup>[0]> = {}) {
    return configureGatewayForSetup({
      flow: "advanced",
      baseConfig: {},
      nextConfig: {},
      quickstartGateway: createQuickstartGateway("token"),
      prompter: createPrompter({ selectQueue: [], textQueue: [] }),
      ...overrides,
    });
  }

  it("provisions a store ref when reference mode has no token to point at", async () => {
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("wizard-gateway-ref-")),
        OPENCLAW_GATEWAY_TOKEN: undefined,
      },
      async () => {
        const result = await configure({ flow: "quickstart", secretInputMode: "ref" });

        expect(result.nextConfig.gateway?.auth?.token).toEqual({
          source: "store",
          provider: "default",
          id: "OPENCLAW_GATEWAY_TOKEN",
        });
        const { readSecretStoreValue } = await import("../secrets/store/secret-store.js");
        const stored = readSecretStoreValue({
          scope: { kind: "team" },
          name: "OPENCLAW_GATEWAY_TOKEN",
        });
        expect(stored.ok && stored.value).toBe(result.settings.gatewayToken);
      },
    );
  });

  it("quickstart generates a Gateway secret without an auth or secret text prompt", async () => {
    mocks.randomToken.mockReturnValue("generated-token");
    const prompter = createPrompter({ selectQueue: [], textQueue: [] });
    const result = await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: undefined }, () =>
      configure({
        flow: "quickstart",
        quickstartGateway: resolveQuickstartGatewayDefaults({}),
        prompter,
      }),
    );
    expect(result.nextConfig.gateway?.auth).toEqual({ mode: "token", token: "generated-token" });
    expect(prompter.select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Gateway access protection" }),
    );
    expect(prompter.text).not.toHaveBeenCalled();
    expect(result.nextConfig.gateway?.nodes?.commands).toBeUndefined();
    expect(result.nextConfig.gateway?.controlUi).toBeUndefined();
  });

  it("preserves an existing password-mode config without an auth prompt", async () => {
    const baseConfig = {
      gateway: { auth: { mode: "password" as const, password: "saved-password" } },
    };
    const prompter = createPrompter({ selectQueue: [], textQueue: [] });
    const result = await configure({
      baseConfig,
      nextConfig: baseConfig,
      quickstartGateway: resolveQuickstartGatewayDefaults(baseConfig),
      prompter,
    });
    expect(result.nextConfig.gateway?.auth).toEqual(baseConfig.gateway.auth);
    expect(prompter.select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Gateway access protection" }),
    );
    expect(prompter.confirm).not.toHaveBeenCalled();
  });

  it.each(["quickstart", "advanced"] as const)(
    "%s preserves an existing trusted-proxy config without an auth prompt",
    async (flow) => {
      // Rerunning onboarding must not downgrade an identity-bearing gateway to
      // token auth, and must not mint a token beside the kept trustedProxy block.
      const baseConfig = {
        gateway: {
          auth: {
            mode: "trusted-proxy" as const,
            trustedProxy: {
              userHeader: "x-forwarded-user",
              requiredHeaders: ["x-forwarded-user"],
            },
          },
          trustedProxies: ["10.0.0.5"],
        },
      };
      const prompter = createPrompter({ selectQueue: [], textQueue: [] });
      const result = await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: undefined }, () =>
        configureGatewayForSetup({
          flow,
          baseConfig,
          nextConfig: baseConfig,
          quickstartGateway: resolveQuickstartGatewayDefaults(baseConfig),
          prompter,
        }),
      );
      expect(result.nextConfig.gateway?.auth).toEqual(baseConfig.gateway.auth);
      expect(result.nextConfig.gateway?.auth?.token).toBeUndefined();
      expect(result.nextConfig.gateway?.trustedProxies).toEqual(["10.0.0.5"]);
      expect(prompter.select).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: "Gateway access protection" }),
      );
      expect(prompter.confirm).not.toHaveBeenCalled();
    },
  );

  it("refuses to rewrite a trusted-proxy gateway to password for tailscale funnel", async () => {
    // A local-only password must not become a remote shared secret merely
    // because Funnel was selected.
    const baseConfig = {
      gateway: {
        auth: {
          mode: "trusted-proxy" as const,
          password: "synthetic-local-password",
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-user"],
          },
        },
        trustedProxies: ["10.0.0.5"],
      },
    };
    await expect(
      configure({
        flow: "quickstart",
        baseConfig,
        nextConfig: baseConfig,
        quickstartGateway: resolveQuickstartGatewayDefaults(baseConfig, { tailscale: "funnel" }),
      }),
    ).rejects.toThrow(/Funnel requires password auth/);
  });

  it("still switches token auth to password for tailscale funnel", async () => {
    mocks.getTailnetHostname.mockResolvedValue("test-tailnet.ts.net");
    const baseConfig = {
      gateway: {
        auth: { mode: "token" as const, token: "existing-token" },
      },
    };
    const result = await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: undefined }, () =>
      configure({
        flow: "quickstart",
        baseConfig,
        nextConfig: baseConfig,
        quickstartGateway: resolveQuickstartGatewayDefaults(baseConfig, { tailscale: "funnel" }),
        prompter: createPrompter({ selectQueue: [], textQueue: ["synthetic-funnel-password"] }),
      }),
    );
    expect(result.nextConfig.gateway?.auth?.mode).toBe("password");
    expect(result.nextConfig.gateway?.auth?.password).toBe("synthetic-funnel-password");
    expect(result.nextConfig.gateway?.tailscale?.mode).toBe("funnel");
  });

  it("seeds advanced gateway prompts from explicit classic options", async () => {
    const gatewayDefaults = resolveQuickstartGatewayDefaults(
      {},
      {
        gatewayPort: 19511,
        gatewayBind: "lan",
        gatewayPassword: "manual-gateway-password-placeholder",
        tailscale: "off",
      },
    );
    const select = vi.fn(async (params: WizardSelectParams<unknown>) => {
      return params.initialValue ?? params.options[0]?.value;
    }) as unknown as WizardPrompter["select"];
    const text = vi.fn(async (params: { initialValue?: string }) => params.initialValue ?? "");
    const confirm = vi.fn(
      async (params: { initialValue?: boolean }) => params.initialValue ?? false,
    );
    const prompter = buildWizardPrompter({ select, text, confirm });

    const result = await configure({
      flow: "advanced",
      quickstartGateway: gatewayDefaults,
      prompter,
    });

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Gateway port", initialValue: "19511" }),
    );
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Gateway bind address", initialValue: "lan" }),
    );
    expect(select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Gateway access protection" }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Tailscale exposure", initialValue: "off" }),
    );
    expect(result.nextConfig.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:19511",
      "http://127.0.0.1:19511",
    ]);
    expect(result.nextConfig.gateway).toMatchObject({
      port: 19511,
      bind: "lan",
      auth: { mode: "password", password: "manual-gateway-password-placeholder" },
      tailscale: { mode: "off" },
    });
  });

  it("rejects loose gateway port input", async () => {
    mocks.randomToken.mockReturnValue("generated-token");

    await expect(
      configure({ prompter: createPrompter({ selectQueue: [], textQueue: ["1e3"] }) }),
    ).rejects.toThrow("Use a port number from 1 to 65535");
  });

  it("keeps OPENCLAW_GATEWAY_TOKEN in advanced flow without a credential prompt", async () => {
    mocks.randomToken.mockReturnValue("should-not-be-used");
    mocks.randomToken.mockClear();

    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "advanced-env-token" }, async () => {
      const result = await configure({
        prompter: createPrompter({ selectQueue: ["loopback", "off"], textQueue: ["18789"] }),
      });

      expect(result.settings.gatewayToken).toBe("advanced-env-token");
      expect(mocks.randomToken).not.toHaveBeenCalled();
    });
  });

  it("does not set password to literal 'undefined' when prompt returns undefined", async () => {
    mocks.randomToken.mockReturnValue("unused");
    const result = await configure({
      quickstartGateway: createQuickstartGateway("password"),
      prompter: createPrompter({ selectQueue: [], textQueue: ["18789", undefined] }),
    });

    const authConfig = result.nextConfig.gateway?.auth as { mode?: string; password?: string };
    expect(authConfig?.mode).toBe("password");
    expect(authConfig?.password).toBe("");
    expect(authConfig?.password).not.toBe("undefined");
  });

  it("preserves effective origins when adding Tailscale", async () => {
    mocks.getTailnetHostname.mockResolvedValue("test-tailnet.ts.net");
    const result = await configure({
      prompter: createPrompter({ selectQueue: ["loopback", "serve"], textQueue: [] }),
      nextConfig: { gateway: { publicOrigin: "https://team.example.com" } },
    });
    expect(result.nextConfig.gateway?.controlUi?.allowedOrigins).toEqual([
      "https://team.example.com",
      "https://test-tailnet.ts.net",
    ]);
  });

  it("replaces a saved plaintext password with the selected SecretRef", async () => {
    await withEnvAsync({ OPENCLAW_GATEWAY_PASSWORD: "gateway-secret" }, async () => {
      const baseConfig = {
        gateway: { auth: { mode: "password" as const, password: "gateway-secret" } },
      };
      const result = await configure({
        baseConfig,
        nextConfig: baseConfig,
        quickstartGateway: resolveQuickstartGatewayDefaults(baseConfig),
        secretInputMode: "ref",
        prompter: createPrompter({
          selectQueue: ["loopback", "off", "env"],
          textQueue: ["18789", "OPENCLAW_GATEWAY_PASSWORD"],
        }),
      });
      expect(result.nextConfig.gateway?.auth).toEqual({
        mode: "password",
        password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
      });
    });
  });

  it("routes a seeded quickstart password through the configured SecretRef provider", async () => {
    const password = "gateway-password-from-exec";
    const quickstartGateway = resolveQuickstartGatewayDefaults(
      {},
      { gatewayAuth: "password", gatewayPassword: password },
    );
    const prompter = createPrompter({
      selectQueue: ["provider", "gatewaypasswords"],
      textQueue: ["gateway/auth/password"],
    });

    const result = await withSecureTestNodeCommand(async (command) =>
      withEnvAsync({ OPENCLAW_GATEWAY_PASSWORD: undefined }, async () =>
        configure({
          flow: "quickstart",
          nextConfig: {
            secrets: {
              providers: {
                gatewaypasswords: {
                  source: "exec",
                  command,
                  args: [
                    "-e",
                    "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const req=JSON.parse(input||'{}');const values={};for(const id of req.ids||[]){values[id]='gateway-password-from-exec';}process.stdout.write(JSON.stringify({protocolVersion:1,values}));});",
                  ],
                },
              },
            },
          },
          quickstartGateway,
          secretInputMode: "ref",
          prompter,
        }),
      ),
    );

    expect(result.nextConfig.gateway?.auth).toMatchObject({
      mode: "password",
      password: {
        source: "exec",
        provider: "gatewaypasswords",
        id: "gateway/auth/password",
      },
    });
  });

  it("stores gateway token as SecretRef when secretInputMode=ref", async () => {
    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "token-from-env" }, async () => {
      const prompter = createPrompter({
        selectQueue: ["loopback", "off", "env"],
        textQueue: ["18789", "OPENCLAW_GATEWAY_TOKEN"],
      });

      const result = await configure({
        flow: "advanced",
        quickstartGateway: createQuickstartGateway("token"),
        secretInputMode: "ref", // pragma: allowlist secret
        prompter,
      });

      expect(result.nextConfig.gateway?.auth?.mode).toBe("token");
      expect(result.nextConfig.gateway?.auth?.token).toEqual({
        source: "env",
        provider: "default",
        id: "OPENCLAW_GATEWAY_TOKEN",
      });
      expect(result.settings.gatewayToken).toBe("token-from-env");
    });
  });

  it("resolves quickstart exec SecretRefs for gateway token bootstrap", async () => {
    const quickstartGateway = {
      ...createQuickstartGateway("token"),
      token: {
        source: "exec" as const,
        provider: "gatewaytokens",
        id: "gateway/auth/token",
      },
    };

    const prompter = createPrompter({
      selectQueue: [],
      textQueue: [],
    });

    const result = await withSecureTestNodeExecPath(async () =>
      configure({
        flow: "quickstart",
        nextConfig: {
          secrets: {
            providers: {
              gatewaytokens: {
                source: "exec",
                command: process.execPath,
                args: [
                  "-e",
                  "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const req=JSON.parse(input||'{}');const values={};for(const id of req.ids||[]){values[id]='token-from-exec';}process.stdout.write(JSON.stringify({protocolVersion:1,values}));});",
                ],
              },
            },
          },
        },
        quickstartGateway,
        prompter,
      }),
    );

    expect(result.nextConfig.gateway?.auth?.token).toEqual(quickstartGateway.token);
    expect(result.settings.gatewayToken).toBe("token-from-exec");
  });

  it("seeds an explicit env token ref into advanced gateway setup", async () => {
    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "token-from-env-ref" }, async () => {
      const gatewayDefaults = resolveQuickstartGatewayDefaults(
        {},
        { gatewayPort: 19511, gatewayTokenRefEnv: "OPENCLAW_GATEWAY_TOKEN" },
      );
      const result = await configure({
        flow: "advanced",
        quickstartGateway: gatewayDefaults,
        prompter: createPrompter({ selectQueue: [], textQueue: [] }),
      });

      expect(result.nextConfig.gateway?.auth).toEqual({
        mode: "token",
        token: {
          source: "env",
          provider: "default",
          id: "OPENCLAW_GATEWAY_TOKEN",
        },
      });
      expect(result.settings.gatewayToken).toBe("token-from-env-ref");
    });
  });

  it("persists classic quickstart overrides through gateway safety normalization", async () => {
    const password = ["classic", "gateway", "placeholder"].join("-");
    mocks.getTailnetHostname.mockResolvedValue("test-tailnet.ts.net");
    const note = vi.fn(async () => {});
    const prompter = buildWizardPrompter({ note });
    const quickstartGateway = resolveQuickstartGatewayDefaults(
      {},
      {
        gatewayPort: 19001,
        gatewayBind: "lan",
        gatewayAuth: "token",
        gatewayToken: "unused-token",
        gatewayPassword: password,
        tailscale: "funnel",
      },
    );

    const result = await configure({
      flow: "quickstart",
      quickstartGateway,
      prompter,
    });

    expect(result.nextConfig.gateway).toMatchObject({
      port: 19001,
      bind: "loopback",
      auth: { mode: "password", password },
      tailscale: { mode: "funnel" },
    });
    expect(result.nextConfig.gateway?.auth?.token).toBeUndefined();
    expect(JSON.stringify(note.mock.calls)).not.toContain(password);
  });
});
