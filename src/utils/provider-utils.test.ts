import { describe, expect, it } from "vitest";
import { isLocalProviderUrl, isReasoningTagProvider } from "./provider-utils.js";

describe("isReasoningTagProvider", () => {
  it("returns true for ollama", () => {
    expect(isReasoningTagProvider("ollama")).toBe(true);
  });

  it("returns false for anthropic", () => {
    expect(isReasoningTagProvider("anthropic")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isReasoningTagProvider(null)).toBe(false);
    expect(isReasoningTagProvider(undefined)).toBe(false);
  });
});

describe("isLocalProviderUrl", () => {
  it("returns true for localhost URLs", () => {
    expect(isLocalProviderUrl("http://localhost:11434")).toBe(true);
    expect(isLocalProviderUrl("http://localhost:11434/v1")).toBe(true);
  });

  it("returns true for 127.0.0.0/8 loopback range", () => {
    expect(isLocalProviderUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isLocalProviderUrl("http://127.0.0.2:11434")).toBe(true);
    expect(isLocalProviderUrl("http://127.1.1.1:8080")).toBe(true);
  });

  it("returns true for ::1 (IPv6 loopback)", () => {
    expect(isLocalProviderUrl("http://[::1]:11434")).toBe(true);
  });

  it("returns true for 0.0.0.0", () => {
    expect(isLocalProviderUrl("http://0.0.0.0:11434")).toBe(true);
  });

  it("returns true for private 192.168.x.x addresses", () => {
    expect(isLocalProviderUrl("http://192.168.1.100:11434")).toBe(true);
    expect(isLocalProviderUrl("http://192.168.50.213:8080")).toBe(true);
  });

  it("returns true for private 10.x.x.x addresses", () => {
    expect(isLocalProviderUrl("http://10.0.0.1:11434")).toBe(true);
  });

  it("returns true for private 172.16-31.x.x addresses", () => {
    expect(isLocalProviderUrl("http://172.16.0.1:11434")).toBe(true);
    expect(isLocalProviderUrl("http://172.31.255.255:11434")).toBe(true);
  });

  it("returns true for .local domains", () => {
    expect(isLocalProviderUrl("http://ollama.local:11434")).toBe(true);
  });

  it("returns false for cloud provider URLs", () => {
    expect(isLocalProviderUrl("https://api.openai.com/v1")).toBe(false);
    expect(isLocalProviderUrl("https://api.anthropic.com")).toBe(false);
    expect(isLocalProviderUrl("https://generativelanguage.googleapis.com")).toBe(false);
  });

  it("returns false for null/undefined/empty", () => {
    expect(isLocalProviderUrl(null)).toBe(false);
    expect(isLocalProviderUrl(undefined)).toBe(false);
    expect(isLocalProviderUrl("")).toBe(false);
  });

  it("returns false for invalid URLs", () => {
    expect(isLocalProviderUrl("not-a-url")).toBe(false);
  });

  it("returns false for 172.15.x.x (not private range)", () => {
    expect(isLocalProviderUrl("http://172.15.0.1:11434")).toBe(false);
  });

  it("returns false for 172.32.x.x (not private range)", () => {
    expect(isLocalProviderUrl("http://172.32.0.1:11434")).toBe(false);
  });
});
