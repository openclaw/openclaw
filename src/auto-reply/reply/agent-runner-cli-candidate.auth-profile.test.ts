// Tests the CLI dispatch boundary's auth identity conversion: a session pin
// resolved for the model provider must not leak into a claude-cli child as a
// forwarded API key when auth.order names the backend's native login.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import {
  resolveCliForwardedAuthProfileId,
  resolveRunAuthProfile,
} from "./agent-runner-auth-profile.js";
import type { FollowupRun } from "./queue.js";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  profiles: {} as Record<string, AuthProfileCredential>,
}));

vi.mock("../../agents/auth-profiles/store-runtime.js", () => ({
  loadAuthProfileStoreForRuntime: () => ({ version: 1, profiles: mocks.profiles }),
}));

vi.mock("../../agents/auth-profiles/order.js", () => ({
  resolveAuthProfileOrder: () => mocks.order,
}));

const sessionPinRun = {
  provider: "anthropic",
  authProfileId: "anthropic:default",
  authProfileIdSource: "auto",
} as FollowupRun["run"];

describe("reply CLI dispatch auth identity", () => {
  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
      ],
      resolvePluginSetupCliBackend: () => undefined,
    });
    mocks.order.length = 0;
    for (const profileId of Object.keys(mocks.profiles)) {
      delete mocks.profiles[profileId];
    }
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
  });

  it("drops a model-provider auto pin at the CLI dispatch boundary", () => {
    // Issue repro: auth.order.claude-cli names the backend's native login, the
    // store only holds an api_key profile for the model provider, and the
    // session layer auto-pins it for the turn. The boundary must drop that pin
    // so the CLI child keeps its own login instead of silently billing the
    // stored key.
    mocks.profiles["anthropic:default"] = {
      type: "api_key",
      provider: "anthropic",
      key: "test-anthropic-key",
    };
    // The session layer alone forwards the model-provider pin to the run; the
    // dispatch boundary must convert it to the CLI execution identity.
    expect(resolveRunAuthProfile(sessionPinRun, "claude-cli", { config: {} })).toEqual({
      authProfileId: "anthropic:default",
      authProfileIdSource: "auto",
    });

    expect(
      resolveCliForwardedAuthProfileId({
        candidateRun: sessionPinRun,
        cliExecutionProvider: "claude-cli",
        authProfileProvider: "anthropic",
        config: {},
        agentDir: "/tmp/unused-agent",
      }),
    ).toBeUndefined();
  });

  it("keeps a profile the CLI backend owns and forwards a native login as none", () => {
    mocks.order.push("claude-cli:work");
    mocks.profiles["claude-cli:work"] = {
      type: "api_key",
      provider: "claude-cli",
      key: "test-claude-key",
    };

    expect(
      resolveCliForwardedAuthProfileId({
        candidateRun: {
          provider: "anthropic",
          authProfileId: "claude-cli:work",
          authProfileIdSource: "user",
        } as FollowupRun["run"],
        cliExecutionProvider: "claude-cli",
        authProfileProvider: "anthropic",
        config: {},
        agentDir: "/tmp/unused-agent",
      }),
    ).toBe("claude-cli:work");

    expect(
      resolveCliForwardedAuthProfileId({
        candidateRun: {
          provider: "anthropic",
          authProfileId: "anthropic:claude-cli",
          authProfileIdSource: "user",
        } as FollowupRun["run"],
        cliExecutionProvider: "claude-cli",
        authProfileProvider: "anthropic",
        config: {},
        agentDir: "/tmp/unused-agent",
      }),
    ).toBeUndefined();
  });
});
