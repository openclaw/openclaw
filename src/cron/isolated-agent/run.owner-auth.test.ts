import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../agents/test-helpers/fast-coding-tools.js";
import {
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  resetRunCronIsolatedAgentTurnHarness,
  resolveConfiguredModelRefMock,
  resolveDeliveryTargetMock,
  runCliAgentMock,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const RUN_OWNER_AUTH_TIMEOUT_MS = 300_000;

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      id: "owner-auth",
      name: "Owner Auth",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "check owner tools" },
      delivery: { mode: "none" },
    } as never,
    message: "check owner tools",
    sessionKey: "cron:owner-auth",
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
        message: "check owner tools",
        toolsAllow,
      },
    } as never,
  };
}

function makeCliRuntimeParams() {
  const params = makeParams();
  const job = params.job as Record<string, unknown>;
  return {
    ...params,
    cfg: {
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
          model: "anthropic/claude-opus-4-6",
        },
      },
    },
    job: {
      ...job,
      payload: {
        kind: "agentTurn",
        message: "check owner tools",
        allowUnsafeExternalContent: true,
        externalContentSource: "webhook",
      },
    } as never,
  };
}

describe("runCronIsolatedAgentTurn owner auth", () => {
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
    "passes senderIsOwner=false to isolated cron agent runs",
    { timeout: RUN_OWNER_AUTH_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParams());

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const senderIsOwner = runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.senderIsOwner;
      expect(senderIsOwner).toBe(false);
    },
  );

  it(
    "passes senderIsOwner=false to isolated cron CLI runs",
    { timeout: RUN_OWNER_AUTH_TIMEOUT_MS },
    async () => {
      isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
      resolveConfiguredModelRefMock.mockReturnValue({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
      runCliAgentMock.mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      });

      await runCronIsolatedAgentTurn(makeCliRuntimeParams());

      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
      expect(runCliAgentMock).toHaveBeenCalledTimes(1);
      expect(runCliAgentMock.mock.calls[0]?.[0]).toMatchObject({
        provider: "claude-cli",
        model: "claude-opus-4-6",
        trigger: "cron",
        senderIsOwner: false,
      });
    },
  );

  it(
    "authorizes the exact isolated cron toolsAllow=cron self-removal path",
    { timeout: RUN_OWNER_AUTH_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["cron"]));

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
      expect(call?.senderIsOwner).toBe(false);
      expect(call?.jobId).toBe("owner-auth");
      expect(call?.ownerOnlyToolAllowlist).toEqual(["cron"]);
      expect(call?.toolsAllow).toEqual(["cron"]);
    },
  );

  it(
    "normalizes toolsAllow before authorizing isolated cron self-removal",
    { timeout: RUN_OWNER_AUTH_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow([" CRON "]));

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
      expect(call?.senderIsOwner).toBe(false);
      expect(call?.jobId).toBe("owner-auth");
      expect(call?.ownerOnlyToolAllowlist).toEqual(["cron"]);
      expect(call?.toolsAllow).toEqual([" CRON "]);
    },
  );

  it(
    "does not authorize cron when isolated cron toolsAllow omits cron",
    { timeout: RUN_OWNER_AUTH_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["maniple__check_idle_workers"]));

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
      expect(call?.senderIsOwner).toBe(false);
      expect(call?.ownerOnlyToolAllowlist).toBeUndefined();
      expect(call?.toolsAllow).toEqual(["maniple__check_idle_workers"]);
    },
  );
});
