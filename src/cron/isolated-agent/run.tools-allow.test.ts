import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../agents/test-helpers/fast-coding-tools.js";
import {
  loadRunCronIsolatedAgentTurn,
  resetRunCronIsolatedAgentTurnHarness,
  isCliProviderMock,
  resolveDeliveryTargetMock,
  runEmbeddedPiAgentMock,
  runCliAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const RUN_TOOLS_ALLOW_TIMEOUT_MS = 300_000;

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      id: "tools-allow",
      name: "Tools Allow",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "check allowed tools" },
      delivery: { mode: "none" },
    } as never,
    message: "check allowed tools",
    sessionKey: "cron:tools-allow",
  };
}

function makeParamsWithToolsAllow(toolsAllow: string[]) {
  const params = makeParams();
  const job = params.job as Record<string, unknown>;
  return {
    ...params,
    job: {
      ...job,
      payload: {
        kind: "agentTurn",
        message: "check allowed tools",
        toolsAllow,
      },
    } as never,
  };
}

function requireEmbeddedAgentCall(): {
  jobId?: string;
  senderIsOwner?: boolean;
  toolsAllow?: string[];
} {
  const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as
    | {
        jobId?: string;
        senderIsOwner?: boolean;
        toolsAllow?: string[];
      }
    | undefined;
  if (!call) {
    throw new Error("Expected embedded PI agent call for toolsAllow passthrough");
  }
  return call;
}

describe("runCronIsolatedAgentTurn toolsAllow passthrough", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetRunCronIsolatedAgentTurnHarness();
    resolveDeliveryTargetMock.mockResolvedValue({
      channel: "forum",
      to: "123",
      accountId: undefined,
      error: undefined,
    });
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });
  });

  afterEach(() => {
    if (previousFastTestEnv == null) {
      vi.unstubAllEnvs();
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    vi.stubEnv("OPENCLAW_TEST_FAST", previousFastTestEnv);
  });

  it(
    "passes through isolated cron toolsAllow=cron self-removal path",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["cron"]));

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const call = requireEmbeddedAgentCall();
      expect(call.jobId).toBe("tools-allow");
      expect(call.toolsAllow).toEqual(["cron"]);
    },
  );

  it(
    "marks embedded isolated cron runs as owner-authorized for explicitly allowed tools",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["exec"]));

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const call = requireEmbeddedAgentCall();
      expect(call.senderIsOwner).toBe(true);
      expect(call.toolsAllow).toEqual(["exec"]);
    },
  );

  it(
    "marks CLI isolated cron runs as owner-authorized for explicitly allowed tools",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      isCliProviderMock.mockReturnValue(true);
      runCliAgentMock.mockResolvedValue({
        payloads: [{ text: "cli output" }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      });

      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["exec"]));

      expect(runCliAgentMock).toHaveBeenCalledTimes(1);
      const call = runCliAgentMock.mock.calls[0]?.[0] as
        | { senderIsOwner?: boolean; toolsAllow?: string[] }
        | undefined;
      expect(call?.senderIsOwner).toBe(true);
      expect(call?.toolsAllow).toEqual(["exec"]);
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    },
  );

  it(
    "preserves cron toolsAllow casing for downstream policy resolution",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow([" CRON "]));

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const call = requireEmbeddedAgentCall();
      expect(call.jobId).toBe("tools-allow");
      expect(call.toolsAllow).toEqual([" CRON "]);
    },
  );

  it(
    "passes through non-cron toolsAllow entries",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["maniple__check_idle_workers"]));

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const call = requireEmbeddedAgentCall();
      expect(call.toolsAllow).toEqual(["maniple__check_idle_workers"]);
    },
  );
});
