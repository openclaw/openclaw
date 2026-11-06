/** Tests secrets plan normalization, target validation, and ref conversion. */
import { beforeAll, describe, expect, it } from "vitest";
import { isSecretsApplyPlan, resolveValidatedPlanTarget } from "./plan.js";
import { resolveConfigSecretTargetByPath } from "./target-registry.js";

describe("secrets plan validation", () => {
  beforeAll(() => {
    resolveConfigSecretTargetByPath(["channels", "telegram", "botToken"]);
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

  it("rejects path-like channel ids without throwing", () => {
    expect(
      resolveValidatedPlanTarget({
        type: "channels.foo/bar.token",
        path: "channels.foo/bar.token",
        pathSegments: ["channels", "foo/bar", "token"],
      }),
    ).toBeNull();
  });

  it("accepts plugin-managed exec provider upserts in plan files", () => {
    const isValid = isSecretsApplyPlan({
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-02-28T00:00:00.000Z",
      generatedBy: "manual",
      providerUpserts: {
        "team-secrets": {
          source: "exec",
          pluginIntegration: {
            pluginId: "acme-secrets",
            integrationId: "secret-store",
          },
        },
      },
      targets: [],
    });
    expect(isValid).toBe(true);
  });

  it("requires agentId for auth-profiles plan targets", () => {
    const target = {
      type: "auth-profiles.api_key.key",
      path: "profiles.openai:default.key",
      pathSegments: ["profiles", "openai:default", "key"],
      ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    };
    const plan = {
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-02-28T00:00:00.000Z",
      generatedBy: "manual",
      targets: [target],
    };
    expect(isSecretsApplyPlan(plan)).toBe(false);
    expect(isSecretsApplyPlan({ ...plan, targets: [{ ...target, agentId: "main" }] })).toBe(true);
  });
});
