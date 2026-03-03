import { describe, expect, it } from "vitest";
import { isSecretsApplyPlan, resolveValidatedPlanTarget } from "./plan.js";

describe("secrets plan validation", () => {
  it("accepts legacy provider target types", () => {
    const resolved = resolveValidatedPlanTarget({
      type: "models.providers.apiKey",
      path: "models.providers.openai.apiKey",
      pathSegments: ["models", "providers", "openai", "apiKey"],
      providerId: "openai",
    });
    expect(resolved?.pathSegments).toEqual(["models", "providers", "openai", "apiKey"]);
  });

  it("accepts expanded target types beyond legacy surface", () => {
    const resolved = resolveValidatedPlanTarget({
      type: "channels.telegram.botToken",
      path: "channels.telegram.botToken",
      pathSegments: ["channels", "telegram", "botToken"],
    });
    expect(resolved?.pathSegments).toEqual(["channels", "telegram", "botToken"]);
  });

  it("rejects target paths that do not match the registered shape", () => {
    const resolved = resolveValidatedPlanTarget({
      type: "channels.telegram.botToken",
      path: "channels.telegram.webhookSecret",
      pathSegments: ["channels", "telegram", "webhookSecret"],
    });
    expect(resolved).toBeNull();
  });

  it("validates plan files with non-legacy target types", () => {
    const isValid = isSecretsApplyPlan({
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-02-28T00:00:00.000Z",
      generatedBy: "manual",
      targets: [
        {
          type: "talk.apiKey",
          path: "talk.apiKey",
          pathSegments: ["talk", "apiKey"],
          ref: { source: "env", provider: "default", id: "TALK_API_KEY" },
        },
      ],
    });
    expect(isValid).toBe(true);
  });

  it("requires agentId for auth-profiles plan targets", () => {
    const withoutAgent = isSecretsApplyPlan({
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-02-28T00:00:00.000Z",
      generatedBy: "manual",
      targets: [
        {
          type: "auth-profiles.api_key.key",
          path: "profiles.openai:default.key",
          pathSegments: ["profiles", "openai:default", "key"],
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
    });
    expect(withoutAgent).toBe(false);

    const withAgent = isSecretsApplyPlan({
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-02-28T00:00:00.000Z",
      generatedBy: "manual",
      targets: [
        {
          type: "auth-profiles.api_key.key",
          path: "profiles.openai:default.key",
          pathSegments: ["profiles", "openai:default", "key"],
          agentId: "main",
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
    });
    expect(withAgent).toBe(true);
  });
});
