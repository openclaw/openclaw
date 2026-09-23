import { describe, expect, it } from "vitest";
import {
  assertAllowedCompletionModel,
  assertAllowedModelOverride,
  resolveAllowAgentIdOverride,
  resolveAuthorityModelPolicy,
  resolveRequestedRuntimeAgentId,
} from "./runtime-model-policy.js";

describe("shared runtime model policy", () => {
  it("leaves omitted agent selection to each caller and keeps host bindings authoritative", () => {
    expect(resolveRequestedRuntimeAgentId({ allowAgentIdOverride: false })).toBeUndefined();
    expect(
      resolveRequestedRuntimeAgentId({ agentId: " Worker ", allowAgentIdOverride: true }),
    ).toBe("worker");
    expect(
      resolveRequestedRuntimeAgentId({
        agentId: "worker",
        authority: { agentId: "main" },
        allowAgentIdOverride: true,
      }),
    ).toBe("main");
    expect(() =>
      resolveRequestedRuntimeAgentId({
        authority: { requiresBoundAgent: true },
        allowAgentIdOverride: true,
      }),
    ).toThrow("not bound to an active session agent");
    expect(
      resolveAllowAgentIdOverride({
        authority: { allowAgentIdOverride: false },
        pluginPolicy: resolveAuthorityModelPolicy({ allowAgentIdOverride: true }),
      }),
    ).toBe(false);
  });

  it.each(["completion", "override"] as const)(
    "intersects independent host/plugin %s restrictions, including wildcard grants",
    (kind) => {
      const policy = (models: string[]) =>
        resolveAuthorityModelPolicy({
          allowModelOverride: true,
          allowedModels: models,
          allowedCompletionModels: models,
        });
      const check = (host: string[], plugin: string[]) => {
        const params = {
          resolvedModelRef: "fixture/selected",
          pluginPolicyId: "consumer",
          authorityPolicy: policy(host),
          pluginPolicy: policy(plugin),
        };
        return kind === "completion"
          ? assertAllowedCompletionModel(params)
          : assertAllowedModelOverride(params);
      };
      expect(() => check(["*"], ["fixture/other"])).toThrow("not allowlisted");
      expect(() => check(["fixture/other"], ["*"])).toThrow("not allowlisted");
      expect(() => check(["*"], [])).toThrow("no valid models");
      expect(() => check(["fixture/selected"], ["*"])).not.toThrow();
    },
  );
});
