import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  resolveAgentConfigMock,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
  updateSessionStoreMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeJob(overrides?: Record<string, unknown>) {
  return {
    id: "mcp-cleanup-job",
    name: "MCP Cleanup Test",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    payload: {
      kind: "agentTurn",
      message: "noop",
    },
    ...overrides,
  } as never;
}

function makeParams(overrides?: Record<string, unknown>) {
  return {
    cfg: {},
    deps: {} as never,
    job: makeJob(),
    message: "noop",
    sessionKey: "cron:mcp-cleanup",
    ...overrides,
  };
}

describe("runCronIsolatedAgentTurn — MCP subprocess cleanup (#68623)", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();

    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      return { ref: { provider: "anthropic", model: raw.split("/").pop() ?? "claude-sonnet-4-6" } };
    });
    resolveAgentConfigMock.mockReturnValue(undefined);
    updateSessionStoreMock.mockResolvedValue(undefined);
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: makeCronSessionEntry({
          model: undefined,
          modelProvider: undefined,
        }),
        isNewSession: true,
      }),
    );
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("passes cleanupBundleMcpOnRunEnd=true to the embedded runner so bundled-MCP subprocesses are disposed after each isolated cron turn", async () => {
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: { agentMeta: { usage: { input: 10, output: 5 } } },
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    const embeddedCall = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as
      | { cleanupBundleMcpOnRunEnd?: boolean; trigger?: string }
      | undefined;
    // Regression: isolated cron runs must opt into MCP runtime disposal. Without
    // this flag the runEmbeddedPiAgent dispose hook is a no-op, so each cron
    // fire leaks one MCP child process (e.g. the Lightpanda binary spawned via
    // mcp.servers in the reporter's config).
    expect(embeddedCall?.cleanupBundleMcpOnRunEnd).toBe(true);
    expect(embeddedCall?.trigger).toBe("cron");
  });
});
