import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import {
  buildEmbeddedRunBaseParams,
  resolveProviderScopedAuthProfile,
} from "./agent-runner-utils.js";
import type { FollowupRun } from "./queue.js";

function makeRun(config: OpenClawConfig): FollowupRun["run"] {
  return {
    sessionId: "session-1",
    agentId: "agent-1",
    config,
    provider: "openai",
    model: "gpt-4.1",
    agentDir: "/tmp/agent",
    sessionKey: "agent:test:session",
    sessionFile: "/tmp/session.json",
    workspaceDir: "/tmp/workspace",
    skillsSnapshot: [],
    ownerNumbers: ["+15550001"],
    enforceFinalTag: false,
    thinkLevel: "medium",
    verboseLevel: "off",
    reasoningLevel: "none",
    execOverrides: {},
    bashElevated: false,
    timeoutMs: 60_000,
  } as unknown as FollowupRun["run"];
}

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

describe("buildEmbeddedRunBaseParams runtime config", () => {
  it("prefers the active runtime snapshot when queued reply config still contains SecretRefs", () => {
    const sourceConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: {
              source: "env",
              provider: "default",
              id: "OPENAI_API_KEY",
            },
            models: [],
          },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "resolved-runtime-key",
            models: [],
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const resolved = buildEmbeddedRunBaseParams({
      run: makeRun(sourceConfig),
      provider: "openai",
      model: "gpt-4.1-mini",
      runId: "run-1",
      authProfile: resolveProviderScopedAuthProfile({
        provider: "openai",
        primaryProvider: "openai",
      }),
    });

    expect(resolved.config).toBe(runtimeConfig);
  });
});
