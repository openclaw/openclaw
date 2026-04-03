import { describe, expect, it } from "vitest";
import { buildAgentCard } from "./a2a-agent-card.js";
import type { OpenClawConfig } from "../config/types.js";

function makeConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    agents: {
      list: [
        { id: "main", default: true, name: "Main Agent" },
        { id: "worker", name: "Worker" },
      ],
    },
    ...overrides,
  } as OpenClawConfig;
}

describe("buildAgentCard", () => {
  it("builds a minimal agent card with defaults", () => {
    const cfg = makeConfig({
      gateway: { a2a: { enabled: true } },
    });
    const card = buildAgentCard(cfg, "http://localhost:18789");

    expect(card.name).toBe("Main Agent");
    expect(card.url).toBe("http://localhost:18789/a2a");
    expect(card.version).toBe("0.2.0");
    expect(card.capabilities.streaming).toBe(false);
    expect(card.capabilities.pushNotifications).toBe(false);
    expect(card.defaultInputModes).toEqual(["text"]);
    expect(card.defaultOutputModes).toEqual(["text"]);
    // Default chat skill added when no skills configured.
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe("chat");
  });

  it("uses configured name and description", () => {
    const cfg = makeConfig({
      gateway: {
        a2a: {
          enabled: true,
          name: "My A2A Agent",
          description: "Does cool things",
        },
      },
    });
    const card = buildAgentCard(cfg, "https://example.com");

    expect(card.name).toBe("My A2A Agent");
    expect(card.description).toBe("Does cool things");
  });

  it("uses configured skills instead of default chat", () => {
    const cfg = makeConfig({
      gateway: {
        a2a: {
          enabled: true,
          skills: [
            { id: "summarize", name: "Summarize", description: "Summarize text" },
            { id: "translate", name: "Translate" },
          ],
        },
      },
    });
    const card = buildAgentCard(cfg, "http://localhost");

    expect(card.skills).toHaveLength(2);
    expect(card.skills[0].id).toBe("summarize");
    expect(card.skills[1].id).toBe("translate");
  });

  it("uses configured public URL for the endpoint", () => {
    const cfg = makeConfig({
      gateway: {
        a2a: {
          enabled: true,
          url: "https://public.example.com",
        },
      },
    });
    const card = buildAgentCard(cfg, "http://localhost:18789");

    expect(card.url).toBe("https://public.example.com/a2a");
  });

  it("includes provider info when configured", () => {
    const cfg = makeConfig({
      gateway: {
        a2a: {
          enabled: true,
          provider: { name: "Acme Corp", url: "https://acme.com" },
        },
      },
    });
    const card = buildAgentCard(cfg, "http://localhost");

    expect(card.provider).toEqual({ name: "Acme Corp", url: "https://acme.com" });
  });

  it("includes API key security scheme when auth.apiKey is set", () => {
    const cfg = makeConfig({
      gateway: {
        a2a: {
          enabled: true,
          auth: { apiKey: "secret-key" },
        },
      },
    });
    const card = buildAgentCard(cfg, "http://localhost");

    expect(card.securitySchemes).toBeDefined();
    expect(card.securitySchemes?.apiKey).toEqual({
      type: "apiKey",
      name: "x-api-key",
      in: "header",
    });
    expect(card.security).toEqual([{ apiKey: [] }]);
  });

  it("includes bearer security scheme when bearerTokens is enabled", () => {
    const cfg = makeConfig({
      gateway: {
        a2a: {
          enabled: true,
          auth: { bearerTokens: true },
        },
      },
    });
    const card = buildAgentCard(cfg, "http://localhost");

    expect(card.securitySchemes?.bearer).toEqual({
      type: "http",
      scheme: "bearer",
    });
  });

  it("omits security schemes when no auth configured", () => {
    const cfg = makeConfig({
      gateway: { a2a: { enabled: true } },
    });
    const card = buildAgentCard(cfg, "http://localhost");

    expect(card.securitySchemes).toBeUndefined();
    expect(card.security).toBeUndefined();
  });

  it("strips trailing slashes from gateway URL", () => {
    const cfg = makeConfig({
      gateway: { a2a: { enabled: true } },
    });
    const card = buildAgentCard(cfg, "http://localhost:18789///");

    expect(card.url).toBe("http://localhost:18789/a2a");
  });
});
