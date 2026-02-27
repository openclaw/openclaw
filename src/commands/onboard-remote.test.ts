import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { GatewayBonjourBeacon } from "../infra/bonjour-discovery.js";
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

describe("promptRemoteGatewayConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    const select: WizardPrompter["select"] = vi.fn(async (params) => {
      if (params.message === "Select gateway") {
        return "0" as never;
      }
      if (params.message === "Connection method") {
        return "direct" as never;
      }
      if (params.message === "Gateway auth") {
        return "token" as never;
      }
      return (params.options[0]?.value ?? "") as never;
    });

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

    const cfg = {} as OpenClawConfig;
    const prompter = createPrompter({
      confirm: vi.fn(async () => true),
      select,
      text,
    });

    const next = await promptRemoteGatewayConfig(cfg, prompter);

    expect(next.gateway?.mode).toBe("remote");
    expect(next.gateway?.remote?.url).toBe("wss://gateway.tailnet.ts.net:18789");
    expect(next.gateway?.remote?.token).toBe("token-123");
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Direct remote access defaults to TLS."),
      "Direct remote",
    );
  });

  it("validates insecure ws:// remote URLs and allows loopback ws://", async () => {
    const text: WizardPrompter["text"] = vi.fn(async (params) => {
      if (params.message === "Gateway WebSocket URL") {
        expect(params.validate?.("ws://10.0.0.8:18789")).toContain("Use wss://");
        expect(params.validate?.("ws://127.0.0.1:18789")).toBeUndefined();
        expect(params.validate?.("wss://remote.example.com:18789")).toBeUndefined();
        return "wss://remote.example.com:18789";
      }
      return "";
    }) as WizardPrompter["text"];

    const select: WizardPrompter["select"] = vi.fn(async (params) => {
      if (params.message === "Gateway auth") {
        return "off" as never;
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
    expect(next.gateway?.remote?.token).toBeUndefined();
  });
});
