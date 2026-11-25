import { describe, expect, it } from "vitest";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import {
  assertRequiredWorkerDispatch,
  assertRequiredWorkerSelection,
} from "../../config/required-worker-profile.js";
import { resolveWorkerPlacementDestination } from "./placement-destination.js";

const config = {
  cloudWorkers: {
    requiredProfile: "remote",
    profiles: {
      remote: { provider: "device", settings: { device: "node-1", inference: "worker" } },
      other: { provider: "device" },
    },
  },
};

describe("required worker destination policy", () => {
  it("uses the required profile without a per-session target", () => {
    expect(resolveWorkerPlacementDestination({ cfg: config })).toEqual({
      ok: true,
      value: { profileId: "remote" },
    });
    expect(
      resolveAgentHarnessPolicy({
        config,
        provider: "openai",
        modelId: "test-model",
        agentId: "main",
      }).runtime,
    ).toBe("openclaw");
  });

  it.each([
    { profileId: "other" },
    { catalogId: "external-runtime-catalog" },
    { deviceId: "node-1" },
    { autoDevice: true },
    { machineClass: "large" },
    { os: "linux" },
    { agentRuntime: "external-harness" },
    { execNode: "node-1" },
  ])("rejects session override %j", (selection) => {
    expect(() => assertRequiredWorkerSelection(config, selection)).toThrow(
      "requires worker profile",
    );
  });

  it("does not turn an unavailable required profile into a local destination", () => {
    expect(
      resolveWorkerPlacementDestination({ cfg: { cloudWorkers: { requiredProfile: "missing" } } }),
    ).toEqual({ ok: false, error: "cloud worker profile is not configured: missing" });
  });

  it("leaves ordinary selection unchanged when policy is absent", () => {
    expect(resolveWorkerPlacementDestination({ cfg: {} })).toEqual({ ok: true, value: undefined });
    expect(() =>
      assertRequiredWorkerSelection({}, { execNode: "node-1", agentRuntime: "external-harness" }),
    ).not.toThrow();
  });

  it("fences remote-exec and off-profile dispatches even for internal callers", () => {
    const request = {
      sessionId: "s",
      sessionKey: "agent:main:s",
      agentId: "main",
      profileId: "remote",
      executionMode: "worker-turn" as const,
    };
    expect(() => assertRequiredWorkerDispatch(config, request)).not.toThrow();
    expect(() =>
      assertRequiredWorkerDispatch(config, { ...request, executionMode: "remote-exec" }),
    ).toThrow("requires worker profile");
    expect(() => assertRequiredWorkerDispatch(config, { ...request, profileId: "other" })).toThrow(
      "requires worker profile",
    );
  });
});
