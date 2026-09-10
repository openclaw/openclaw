// Auth profile propagation tests cover isolated agent auth profile forwarding.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileFailurePolicy } from "../agents/embedded-agent-runner/run/auth-profile-failure-policy.types.js";
import {
  makeIsolatedAgentJobFixture,
  makeIsolatedAgentParamsFixture,
} from "./isolated-agent/job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./isolated-agent/run.suite-helpers.js";

const resolveCliExecutionAuthProfileIdMock = vi.hoisted(() => vi.fn());

vi.mock("../agents/cli-execution-auth.js", () => ({
  CliExecutionAuthProfileError: class CliExecutionAuthProfileError extends Error {},
  cliBackendAcceptsAuthProfileForwarding: vi.fn(),
  resolveCliExecutionAuthProfileId: resolveCliExecutionAuthProfileIdMock,
}));

import {
  loadRunCronIsolatedAgentTurn,
  isCliProviderMock,
  mockRunCronFallbackPassthrough,
  resolveConfiguredModelRefMock,
  resolveSessionAuthSelectionMock,
  runEmbeddedAgentMock,
  runCliAgentMock,
} from "./isolated-agent/run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function getEmbeddedAgentParams(): {
  authProfileId?: string;
  authProfileIdSource?: string;
  authProfileFailurePolicy?: AuthProfileFailurePolicy;
} {
  const params = runEmbeddedAgentMock.mock.calls[0]?.[0];
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected embedded OpenClaw agent params to be an object");
  }
  return params;
}

describe("runCronIsolatedAgentTurn auth profile propagation (#20624, #90991)", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });
  beforeEach(() => {
    resolveCliExecutionAuthProfileIdMock.mockReset();
    resolveCliExecutionAuthProfileIdMock.mockReturnValue(undefined);
  });

  it("uses transient-local auth cooldown policy for cron throttling failures", async () => {
    mockRunCronFallbackPassthrough();

    await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          delivery: { mode: "none" },
          payload: { kind: "agentTurn", message: "check status" },
        }),
        message: "check status",
        sessionKey: "cron:job-1",
        lane: "cron",
      }),
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(getEmbeddedAgentParams()).toMatchObject({
      authProfileFailurePolicy: "local_transient",
    });
  });

  it("passes authProfileId to runEmbeddedAgent when auth profiles exist", async () => {
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "openrouter",
      model: "moonshotai/kimi-k2.5",
    });
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "openrouter:default",
      source: "auto",
      routeRequirement: "api-key",
    });
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: {
          auth: {
            profiles: {
              "openrouter:default": {
                provider: "openrouter",
                mode: "api_key",
              },
            },
            order: { openrouter: ["openrouter:default"] },
          },
        },
        job: makeIsolatedAgentJobFixture({
          delivery: { mode: "none" },
          payload: {
            kind: "agentTurn",
            message: "check status",
          },
        }),
        message: "check status",
        sessionKey: "cron:job-1",
        lane: "cron",
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(getEmbeddedAgentParams()).toMatchObject({
      authProfileId: "openrouter:default",
    });
  });

  it("passes authProfileId to runCliAgent when a cron route uses the CLI backend", async () => {
    isCliProviderMock.mockReturnValue(true);
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "claude-cli",
      model: "claude-opus-4-8",
    });
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "claude-cli:manual",
      source: "auto",
      routeRequirement: "api-key",
    });
    resolveCliExecutionAuthProfileIdMock.mockReturnValue("claude-cli:manual");
    runCliAgentMock.mockResolvedValue({
      payloads: [{ text: "check status" }],
      meta: { agentMeta: {} },
    });
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: {
          auth: {
            profiles: {
              "claude-cli:manual": {
                provider: "claude-cli",
                mode: "api_key",
              },
            },
            order: { "claude-cli": ["claude-cli:manual"] },
          },
        },
        job: makeIsolatedAgentJobFixture({
          delivery: { mode: "none" },
          payload: { kind: "agentTurn", message: "check status" },
        }),
        message: "check status",
        sessionKey: "cron:job-1",
        lane: "cron",
      }),
    );

    expect(result.status).toBe("ok");
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    expect(resolveCliExecutionAuthProfileIdMock).toHaveBeenCalledWith({
      cliExecutionProvider: "claude-cli",
      authProfileProvider: "claude-cli",
      config: expect.any(Object),
      agentDir: expect.any(String),
      selected: {
        authProfileId: "claude-cli:manual",
        authProfileIdSource: "auto",
      },
    });
    expect(runCliAgentMock.mock.calls[0]?.[0]).toMatchObject({
      authProfileId: "claude-cli:manual",
    });
  });
});
