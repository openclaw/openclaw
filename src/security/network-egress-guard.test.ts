import { describe, expect, it } from "vitest";
import type { LocalModelSecurityConfig } from "../config/types.local-model-security.js";
import {
  NetworkEgressBlockedError,
  checkEgressPolicy,
  enforceEgressPolicy,
  isCloudProviderHost,
  isLocalNetworkAddress,
  resolveSecurityMode,
  getBlockedCloudProviders,
} from "./network-egress-guard.js";

describe("resolveSecurityMode", () => {
  it("defaults to off when config is undefined", () => {
    expect(resolveSecurityMode(undefined)).toBe("off");
  });

  it("defaults to off when mode is undefined", () => {
    expect(resolveSecurityMode({})).toBe("off");
  });

  it("returns the configured mode", () => {
    expect(resolveSecurityMode({ mode: "enforced" })).toBe("enforced");
    expect(resolveSecurityMode({ mode: "audit" })).toBe("audit");
    expect(resolveSecurityMode({ mode: "off" })).toBe("off");
  });
});

describe("isLocalNetworkAddress", () => {
  it("recognizes RFC 1918 private ranges", () => {
    expect(isLocalNetworkAddress("10.0.0.1")).toBe(true);
    expect(isLocalNetworkAddress("10.255.255.255")).toBe(true);
    expect(isLocalNetworkAddress("172.16.0.1")).toBe(true);
    expect(isLocalNetworkAddress("172.31.255.255")).toBe(true);
    expect(isLocalNetworkAddress("192.168.0.1")).toBe(true);
    expect(isLocalNetworkAddress("192.168.1.100")).toBe(true);
  });

  it("recognizes loopback addresses", () => {
    expect(isLocalNetworkAddress("127.0.0.1")).toBe(true);
    expect(isLocalNetworkAddress("127.0.0.2")).toBe(true);
  });

  it("recognizes link-local addresses", () => {
    expect(isLocalNetworkAddress("169.254.1.1")).toBe(true);
  });

  it("rejects public IP addresses", () => {
    expect(isLocalNetworkAddress("8.8.8.8")).toBe(false);
    expect(isLocalNetworkAddress("1.1.1.1")).toBe(false);
    expect(isLocalNetworkAddress("203.0.113.1")).toBe(false);
  });

  it("recognizes IPv6 loopback", () => {
    expect(isLocalNetworkAddress("::1")).toBe(true);
  });

  it("recognizes IPv6 link-local", () => {
    expect(isLocalNetworkAddress("fe80::1")).toBe(true);
  });

  it("rejects non-IP strings", () => {
    expect(isLocalNetworkAddress("example.com")).toBe(false);
    expect(isLocalNetworkAddress("")).toBe(false);
  });

  it("rejects 172.32.x.x (outside 172.16-31 range)", () => {
    expect(isLocalNetworkAddress("172.32.0.1")).toBe(false);
  });
});

describe("isCloudProviderHost", () => {
  it("identifies known cloud AI providers", () => {
    expect(isCloudProviderHost("api.anthropic.com")).toBe(true);
    expect(isCloudProviderHost("api.openai.com")).toBe(true);
    expect(isCloudProviderHost("generativelanguage.googleapis.com")).toBe(true);
    expect(isCloudProviderHost("api.mistral.ai")).toBe(true);
    expect(isCloudProviderHost("openrouter.ai")).toBe(true);
  });

  it("identifies Bedrock wildcard patterns", () => {
    expect(isCloudProviderHost("bedrock-runtime.ap-northeast-1.amazonaws.com")).toBe(true);
  });

  it("does not flag non-cloud hosts", () => {
    expect(isCloudProviderHost("ollama-server.local")).toBe(false);
    expect(isCloudProviderHost("192.168.1.100")).toBe(false);
    expect(isCloudProviderHost("my-vllm.lan")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isCloudProviderHost("API.ANTHROPIC.COM")).toBe(true);
  });
});

describe("checkEgressPolicy", () => {
  it("allows everything when mode is off", () => {
    const result = checkEgressPolicy("https://api.openai.com/v1/chat", undefined);
    expect(result.allowed).toBe(true);
  });

  it("allows loopback URLs", () => {
    const config: LocalModelSecurityConfig = { mode: "enforced" };
    expect(checkEgressPolicy("http://localhost:11434/api/tags", config).allowed).toBe(true);
    expect(checkEgressPolicy("http://127.0.0.1:11434/api/tags", config).allowed).toBe(true);
    expect(checkEgressPolicy("http://[::1]:11434/api/tags", config).allowed).toBe(true);
  });

  it("allows explicitly listed hosts", () => {
    const config: LocalModelSecurityConfig = {
      mode: "enforced",
      networkEgress: {
        allowedHosts: [{ host: "ollama-server.lan", port: 11434, label: "Ollama" }],
      },
    };
    expect(checkEgressPolicy("http://ollama-server.lan:11434/api/tags", config).allowed).toBe(true);
  });

  it("blocks hosts not in the allow list", () => {
    const config: LocalModelSecurityConfig = {
      mode: "enforced",
      networkEgress: {
        allowedHosts: [{ host: "ollama-server.lan" }],
      },
    };
    expect(checkEgressPolicy("https://api.openai.com/v1/chat", config).allowed).toBe(false);
  });

  it("allows private/LAN IP addresses", () => {
    const config: LocalModelSecurityConfig = { mode: "enforced" };
    expect(checkEgressPolicy("http://192.168.1.100:11434/api/tags", config).allowed).toBe(true);
    expect(checkEgressPolicy("http://10.0.0.5:8000/v1/models", config).allowed).toBe(true);
  });

  it("blocks cloud providers explicitly", () => {
    const config: LocalModelSecurityConfig = {
      mode: "enforced",
      blockCloudProviders: true,
    };
    expect(checkEgressPolicy("https://api.anthropic.com/v1/messages", config).allowed).toBe(false);
    expect(checkEgressPolicy("https://api.openai.com/v1/chat/completions", config).allowed).toBe(
      false,
    );
  });

  it("blocks external requests when blockExternalRequests is not explicitly false", () => {
    const config: LocalModelSecurityConfig = {
      mode: "enforced",
      networkEgress: {},
    };
    const result = checkEgressPolicy("https://example.com/data", config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("external request blocked");
  });

  it("handles invalid URLs gracefully", () => {
    const config: LocalModelSecurityConfig = { mode: "enforced" };
    const result = checkEgressPolicy("not-a-url", config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("invalid URL");
  });

  it("enforces port restrictions on allowed hosts", () => {
    const config: LocalModelSecurityConfig = {
      mode: "enforced",
      networkEgress: {
        allowedHosts: [{ host: "model-server.lan", port: 11434 }],
      },
    };
    expect(checkEgressPolicy("http://model-server.lan:11434/api/tags", config).allowed).toBe(true);
    // Different port is not allowed by the allowlist entry — falls through to IP check
    // model-server.lan is not an IP, so it gets blocked
    expect(checkEgressPolicy("http://model-server.lan:9999/api/tags", config).allowed).toBe(false);
  });
});

describe("enforceEgressPolicy", () => {
  it("does not throw when mode is off", () => {
    expect(() => enforceEgressPolicy("https://api.openai.com/v1/chat")).not.toThrow();
  });

  it("throws NetworkEgressBlockedError in enforced mode", () => {
    const config: LocalModelSecurityConfig = { mode: "enforced" };
    expect(() => enforceEgressPolicy("https://api.openai.com/v1/chat", config)).toThrow(
      NetworkEgressBlockedError,
    );
  });

  it("does not throw in audit mode (logs only)", () => {
    const config: LocalModelSecurityConfig = { mode: "audit" };
    expect(() => enforceEgressPolicy("https://api.openai.com/v1/chat", config)).not.toThrow();
  });

  it("allows local URLs in enforced mode", () => {
    const config: LocalModelSecurityConfig = { mode: "enforced" };
    expect(() => enforceEgressPolicy("http://127.0.0.1:11434/api/tags", config)).not.toThrow();
  });
});

describe("getBlockedCloudProviders", () => {
  it("returns a sorted list of cloud provider domains", () => {
    const providers = getBlockedCloudProviders();
    expect(providers.length).toBeGreaterThan(0);
    expect(providers).toContain("api.anthropic.com");
    expect(providers).toContain("api.openai.com");
    // Check sorted order
    for (let i = 1; i < providers.length; i++) {
      expect(providers[i] >= providers[i - 1]).toBe(true);
    }
  });
});
