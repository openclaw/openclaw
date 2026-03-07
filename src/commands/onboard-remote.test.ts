import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { GatewayBonjourBeacon } from "../infra/bonjour-discovery.js";
import { captureEnv } from "../test-utils/env.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { createWizardPrompter } from "./test-wizard-helpers.js";

const discoverGatewayBeacons = vi.hoisted(() => vi.fn<() => Promise<GatewayBonjourBeacon[]>>());
const resolveWideAreaDiscoveryDomain = vi.hoisted(() => vi.fn(() => undefined));
const detectBinary = vi.hoisted(() => vi.fn<(name: string) => Promise<boolean>>());

vi.mock("../infra/bonjour-discovery.js", () => ({
  discoverGatewayBeacons,
}));

vi.mock("../infra/widearea-dns.js", () => ({
  resolveWideAreaDiscoveryDomain,
}));

vi.mock("./onboard-helpers.js", () => ({
  detectBinary,
}));

const { promptRemoteGatewayConfig } = await import("./onboard-remote.js");

function createPrompter(overrides: Partial<WizardPrompter>): WizardPrompter {
  return createWizardPrompter(overrides, { defaultSelect: "" });
}

function createSelectPrompter(
  responses: Partial<Record<string, string>>,
): WizardPrompter["select"] {
  return vi.fn(async (params) => {
    const value = responses[params.message];
    if (value !== undefined) {
      return value as never;
    }
    return (params.options[0]?.value ?? "") as never;
  });
}

describe("promptRemoteGatewayConfig", () => {
  const envSnapshot = captureEnv(["OPENCLAW_ALLOW_INSECURE_PRIVATE_WS"]);

  async function runRemotePrompt(params: {
    text: WizardPrompter["text"];
    selectResponses: Partial<Record<string, string>>;
    confirm: boolean;
  }) {
    const cfg = {} as OpenClawConfig;
    const prompter = createPrompter({
      confirm: vi.fn(async () => params.confirm),
      select: createSelectPrompter(params.selectResponses),
      text: params.text,
    });
    const next = await promptRemoteGatewayConfig(cfg, prompter);
    return { next, prompter };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    envSnapshot.restore();
    detectBinary.mockResolvedValue(false);
    discoverGatewayBeacons.mockResolvedValue([]);
    resolveWideAreaDiscoveryDomain.mockReturnValue(undefined);
  });

  it("defaults discovered direct remote URLs to wss://", async () => {
    detectBinary.mockResolvedValue(true);
    discoverGatewayBeacons.mockResolvedValue([
      {
        instanceName: "gateway",
        displayName: "Gateway",
        host: "gateway.tailnet.ts.net",
        port: 18789,
      },
    ]);

    const text: WizardPrompter["text"] = vi.fn(async (params) => {
      if (params.message === "Gateway WebSocket URL") {
        expect(params.initialValue).toBe("wss://gateway.tailnet.ts.net:18789");
        expect(params.validate?.(String(params.initialValue))).toBeUndefined();
        return String(params.initialValue);
      }
      if (params.message === "Gateway token") {
        return "token-123";
      }
      return "";
    }) as WizardPrompter["text"];

    const { next, prompter } = await runRemotePrompt({
      text,
      confirm: true,
      selectResponses: {
        "Select gateway": "0",
        "Connection method": "direct",
        "Gateway auth": "token",
      },
    });

    expect(next.gateway?.mode).toBe("remote");
    expect(next.gateway?.remote?.url).toBe("wss://gateway.tailnet.ts.net:18789");
    expect(next.gateway?.remote?.token).toBe("token-123");
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Direct remote access defaults to TLS."),
      "Direct remote",
    );
  });

  it("validates insecure ws:// remote URLs and allows only loopback ws:// by default", async () => {
    const text: WizardPrompter["text"] = vi.fn(async (params) => {
      if (params.message === "Gateway WebSocket URL") {
        // ws:// to public IPs is rejected
        expect(params.validate?.("ws://203.0.113.10:18789")).toContain("Use wss://");
        // ws:// to private IPs remains blocked by default
        expect(params.validate?.("ws://10.0.0.8:18789")).toContain("Use wss://");
        expect(params.validate?.("ws://127.0.0.1:18789")).toBeUndefined();
        expect(params.validate?.("wss://remote.example.com:18789")).toBeUndefined();
        return "wss://remote.example.com:18789";
      }
      return "";
    }) as WizardPrompter["text"];

    const { next } = await runRemotePrompt({
      text,
      confirm: false,
      selectResponses: { "Gateway auth": "off" },
    });

    expect(next.gateway?.mode).toBe("remote");
    expect(next.gateway?.remote?.url).toBe("wss://remote.example.com:18789");
    expect(next.gateway?.remote?.token).toBeUndefined();
  });

  it("allows ws:// hostname remote URLs when OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1", async () => {
    process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS = "1";
    const text: WizardPrompter["text"] = vi.fn(async (params) => {
      if (params.message === "Gateway WebSocket URL") {
        expect(params.validate?.("ws://openclaw-gateway.ai:18789")).toBeUndefined();
        expect(params.validate?.("ws://1.1.1.1:18789")).toContain("Use wss://");
        return "ws://openclaw-gateway.ai:18789";
      }
      return "";
    }) as WizardPrompter["text"];

    const { next } = await runRemotePrompt({
      text,
      confirm: false,
      selectResponses: { "Gateway auth": "off" },
    });

    expect(next.gateway?.mode).toBe("remote");
    expect(next.gateway?.remote?.url).toBe("ws://openclaw-gateway.ai:18789");
  });

  it("supports storing remote auth as an external env secret ref", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "remote-token-value";
    const text: WizardPrompter["text"] = vi.fn(async (params) => {
      if (params.message === "Gateway WebSocket URL") {
        return "wss://remote.example.com:18789";
      }
      if (params.message === "Environment variable name") {
        return "OPENCLAW_GATEWAY_TOKEN";
      }
      return "";
    }) as WizardPrompter["text"];

    const select: WizardPrompter["select"] = vi.fn(async (params) => {
      if (params.message === "Gateway auth") {
        return "token" as never;
      }
      if (params.message === "How do you want to provide this gateway token?") {
        return "ref" as never;
      }
      if (params.message === "Where is this gateway token stored?") {
        return "env" as never;
      }
      return (params.options[0]?.value ?? "") as never;
    });

    const cfg = {} as OpenClawConfig;
    const prompter = createPrompter({
      confirm: vi.fn(async () => false),
      select,
      text,
    });

    const next = await promptRemoteGatewayConfig(cfg, prompter);

    expect(next.gateway?.mode).toBe("remote");
    expect(next.gateway?.remote?.url).toBe("wss://remote.example.com:18789");
    expect(next.gateway?.remote?.token).toEqual({
      source: "env",
      provider: "default",
      id: "OPENCLAW_GATEWAY_TOKEN",
    });
  });
});
