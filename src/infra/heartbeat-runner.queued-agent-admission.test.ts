import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAttemptResult } from "../agents/embedded-agent-runner/run.overflow-compaction.fixture.js";
import {
  createOverflowRunParams,
  loadRunOverflowCompactionHarness,
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
} from "../agents/embedded-agent-runner/run.overflow-compaction.harness.js";
import { resolveNestedAgentLaneForSession } from "../agents/lanes.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getCommandLaneSnapshot,
  getQueueSize,
  resetAllLanes,
  resetCommandLane,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { CommandLane } from "../process/lanes.js";
import { resolveHeartbeatWakeStage } from "./heartbeat-runner-execution.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  readSessionStoreForTest,
  seedHeartbeatScratchForTest,
  seedSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

let runEmbeddedAgent: Awaited<
  ReturnType<typeof loadRunOverflowCompactionHarness>
>["runEmbeddedAgent"];

beforeAll(async () => {
  ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
  const embeddedLaneHelpers = await import("../agents/embedded-agent-runner/lanes.js");
  vi.mocked(embeddedLaneHelpers.resolveGlobalLane).mockImplementation(
    (lane) => lane?.trim() || CommandLane.Main,
  );
});

beforeEach(() => {
  resetSharedRunIntegrationHarnessMocks();
  resetAllLanes();
  resetCommandQueueStateForTest();
});

afterEach(() => {
  resetAllLanes();
  resetCommandQueueStateForTest();
});

function createOpsHeartbeatConfig(
  storePath: string,
  options: { defaultSkipWhenBusy?: boolean; entrySkipWhenBusy?: boolean },
): OpenClawConfig {
  return {
    session: { store: storePath },
    agents: {
      defaults: {
        heartbeat: {
          every: "30m",
          target: "last",
          ...(options.defaultSkipWhenBusy === undefined
            ? {}
            : { skipWhenBusy: options.defaultSkipWhenBusy }),
        },
        model: { primary: "openai/gpt-5.6-luna" },
      },
      list: [
        {
          id: "ops",
          ...(options.entrySkipWhenBusy === undefined
            ? {}
            : { heartbeat: { skipWhenBusy: options.entrySkipWhenBusy } }),
        },
      ],
    },
    channels: {
      telegram: { enabled: true, token: "fake", allowFrom: ["123"] },
    },
  } as unknown as OpenClawConfig;
}

async function waitForQueuedLane(lane: string, isProducerDone: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (getCommandLaneSnapshot(lane).queuedCount > 0) {
      return;
    }
    if (isProducerDone()) {
      throw new Error(`embedded producer settled before queueing ${lane}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`timed out waiting for embedded producer to queue ${lane}`);
}

describe("heartbeat runner admission against queued agent work", () => {
  const queueCases = [
    {
      label: "other-session",
      nested: false,
      setting: "default true",
      config: { defaultSkipWhenBusy: true },
      intent: "scheduled",
      shouldSkip: true,
    },
    {
      label: "nested-agent",
      nested: true,
      setting: "default true",
      config: { defaultSkipWhenBusy: true },
      intent: "scheduled",
      shouldSkip: true,
    },
    {
      label: "other-session",
      nested: false,
      setting: "default false",
      config: { defaultSkipWhenBusy: false },
      intent: "scheduled",
      shouldSkip: false,
    },
    {
      label: "nested-agent",
      nested: true,
      setting: "unset",
      config: {},
      intent: "scheduled",
      shouldSkip: false,
    },
    {
      label: "other-session",
      nested: false,
      setting: "entry false overriding default true",
      config: { defaultSkipWhenBusy: true, entrySkipWhenBusy: false },
      intent: "scheduled",
      shouldSkip: false,
    },
    {
      label: "nested-agent",
      nested: true,
      setting: "entry true overriding default false",
      config: { defaultSkipWhenBusy: false, entrySkipWhenBusy: true },
      intent: "scheduled",
      shouldSkip: true,
    },
    {
      label: "other-session",
      nested: false,
      setting: "default true with immediate intent",
      config: { defaultSkipWhenBusy: true },
      intent: "immediate",
      shouldSkip: true,
    },
    {
      label: "nested-agent",
      nested: true,
      setting: "default true with manual intent",
      config: { defaultSkipWhenBusy: true },
      intent: "manual",
      shouldSkip: true,
    },
  ] as const;

  it.each(queueCases)(
    "$setting $intent wake against real queued $label work",
    async ({ label, nested, config, intent, shouldSkip }) => {
      await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const cfg = createOpsHeartbeatConfig(storePath, config);
        await seedHeartbeatScratchForTest({ content: "- Check status\n", agentId: "ops" });
        const heartbeatSessionKey = "agent:ops:main";
        await seedSessionStore(storePath, heartbeatSessionKey, {
          sessionId: "ops-heartbeat-session",
          updatedAt: 1,
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "123",
        });
        const before = readSessionStoreForTest(storePath)[heartbeatSessionKey];

        const producerSessionKey = `agent:ops:queued-${label}`;
        const sessionLane = `session:${producerSessionKey}`;
        const globalLane = nested
          ? resolveNestedAgentLaneForSession(producerSessionKey)
          : "openclaw-test-producer-global";
        setCommandLaneConcurrency(nested ? globalLane : sessionLane, 0);
        mockedRunEmbeddedAttempt.mockResolvedValueOnce(
          makeAttemptResult({ assistantTexts: ["producer finished"] }),
        );
        let producerDone = false;
        let producerError: unknown;
        const producer = runEmbeddedAgent({
          ...createOverflowRunParams({ workspaceDir: tmpDir }),
          agentId: "ops",
          sessionId: `queued-${label}`,
          sessionKey: producerSessionKey,
          runId: `queued-agent-${label}`,
          workspaceDir: tmpDir,
          config: cfg,
          provider: "openai",
          model: "gpt-5.6-luna",
          lane: globalLane,
        }).then(
          (result) => {
            producerDone = true;
            return result;
          },
          (error: unknown) => {
            producerDone = true;
            producerError = error;
            return undefined;
          },
        );

        try {
          const blockedLane = nested ? globalLane : sessionLane;
          await waitForQueuedLane(blockedLane, () => producerDone);
          if (producerError) {
            throw producerError instanceof Error
              ? producerError
              : new Error("embedded producer failed", { cause: producerError });
          }
          if (nested) {
            // The real producer is now waiting on its nested lane. Retire only
            // its outer session marker so this assertion exercises the nested
            // lane scan on its own.
            resetCommandLane(sessionLane);
          }

          const wakeOptions = {
            cfg,
            agentId: "ops",
            source: "interval",
            intent,
            scheduledEveryMs: 30 * 60_000,
            deps: {
              getReplyFromConfig: replySpy,
              getQueueSize,
              isReplyRunActive: () => false,
              listActiveReplyRunSessionKeys: () => [],
              listActiveEmbeddedRunSessionKeys: () => [],
            },
          } as const;
          if (shouldSkip) {
            const result = await runHeartbeatOnce(wakeOptions);
            expect(result).toEqual({ status: "skipped", reason: "lanes-busy" });
            expect(readSessionStoreForTest(storePath)[heartbeatSessionKey]).toEqual(before);
          } else {
            const wake = await resolveHeartbeatWakeStage(wakeOptions);
            expect(wake.kind).toBe("ready");
          }
          expect(replySpy).not.toHaveBeenCalled();
          expect(getCommandLaneSnapshot(blockedLane).queuedCount).toBeGreaterThan(0);
        } finally {
          setCommandLaneConcurrency(nested ? globalLane : sessionLane, 1);
          setCommandLaneConcurrency(sessionLane, 1);
          await producer;
        }
      });
    },
    15_000,
  );
});
