import { describe, expect, it } from "vitest";
import { validateConfigObjectRawWithPlugins, validateConfigObjectWithPlugins } from "./config.js";

describe("config legacy checks before unknown-key stripping", () => {
  const legacyRoutingConfig = {
    agents: { list: [{ id: "main" }] },
    routing: {
      allowFrom: ["+15550001111"],
    },
  };

  it("rejects legacy keys in validateConfigObjectWithPlugins before sanitizing unknown keys", () => {
    const result = validateConfigObjectWithPlugins(legacyRoutingConfig);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected validation failure");
    }
    expect(result.issues.some((issue) => issue.path === "routing.allowFrom")).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("rejects legacy keys in validateConfigObjectRawWithPlugins before sanitizing unknown keys", () => {
    const result = validateConfigObjectRawWithPlugins(legacyRoutingConfig);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected validation failure");
    }
    expect(result.issues.some((issue) => issue.path === "routing.allowFrom")).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("rejects migratable legacy keys that would otherwise be stripped as unknown", () => {
    const legacyBindingsConfig = {
      agents: { list: [{ id: "main" }] },
      bindings: [{ agentId: "main", match: { channel: "telegram", accountID: "ops" } }],
      messages: {
        queue: {
          byProvider: {
            telegram: "serialized",
          },
        },
      },
      session: {
        sendPolicy: {
          rules: [{ action: "deny", match: { provider: "telegram" } }],
        },
      },
    };

    const result = validateConfigObjectWithPlugins(legacyBindingsConfig);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected validation failure");
    }
    expect(result.issues.some((issue) => issue.path === "bindings[].match.accountID")).toBe(true);
    expect(
      result.issues.some((issue) => issue.path === "session.sendPolicy.rules[].match.provider"),
    ).toBe(true);
    expect(result.issues.some((issue) => issue.path === "messages.queue.byProvider")).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
