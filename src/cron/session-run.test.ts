import { StatementSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createOperatorRecoveryAuthority } from "../agents/operator-recovery.test-support.js";
import type {
  SessionEventOptions,
  SessionEventOutcome,
} from "../auto-reply/reply/session-event-contract.js";
import type * as SessionHandoff from "../auto-reply/reply/session-event-handoff.js";
import type { RestoredGatewayOperatorAuthority } from "../gateway/operator-run-recovery.js";
import { prepareAutomationSystemEvents } from "../infra/system-events.js";
import { writeConfigMachineStateAsync } from "../state/config-machine-state-async.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { resolveCronSourceDeliveryPlan } from "./isolated-agent/source-delivery-plan.js";
import { TEST_SCHEDULED_OCCURRENCE } from "./scheduled-occurrence.test-support.js";
import { createCronAgentWatchdog } from "./service/agent-watchdog.js";
import { runCronSessionTurn } from "./session-run.js";

const fixture = vi.hoisted(() => ({
  config: {},
  capture: vi.fn<typeof SessionHandoff.captureSessionEventTargetForHost>(),
  enqueue: vi.fn<typeof SessionHandoff.enqueueSessionEventForHost>(),
  delivery:
    vi.fn<typeof import("./isolated-agent/run-delivery-trace.js").resolveCronDeliveryContext>(),
  restore: vi.fn<typeof import("../gateway/cron-operator-source.js").restoreCronOperatorSource>(),
  readScratch: vi.fn<typeof import("./scratch-read.js").readCronScratchSnapshot>(),
}));

// mock-isolation: Fixed session receipts exercise the Cron owner without invoking a model.
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: fixture.capture,
  enqueueSessionEventForHost: fixture.enqueue,
}));
// mock-isolation: The fixture supplies current configuration independently of process state.
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => fixture.config }));
// mock-isolation: The fixed route avoids loading external channel runtimes; retain trace logic.
vi.mock("./isolated-agent/run-delivery-trace.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./isolated-agent/run-delivery-trace.js")>()),
  resolveCronDeliveryContext: fixture.delivery,
}));
// mock-isolation: The restoration boundary supplies an independently revocable source lease.
vi.mock("../gateway/cron-operator-source.js", () => ({
  restoreCronOperatorSource: fixture.restore,
}));
// mock-isolation: These receipt/prompt contracts use a job with no saved scratch.
vi.mock("./scratch-read.js", () => ({ readCronScratchSnapshot: fixture.readScratch }));

beforeEach(() => {
  vi.resetAllMocks();
  fixture.capture.mockResolvedValue({
    ...target,
    generation: "target-generation",
  });
  const deliveryPlan = { mode: "none" as const, source: "delivery" as const, requested: false };
  const resolvedDelivery = {
    ok: false as const,
    mode: "implicit" as const,
    error: new Error("delivery is disabled"),
  };
  fixture.delivery.mockResolvedValue({
    deliveryPlan,
    deliveryRequested: false,
    resolvedDelivery,
    sourceDelivery: resolveCronSourceDeliveryPlan({ deliveryPlan, resolvedDelivery }),
    deliverySystemPrompt: undefined,
    messageToolFormatPrompt: undefined,
  });
});

afterEach(() => vi.useRealTimers());

const target = {
  sessionId: "target-session",
  sessionKey: "agent:main:scheduled",
  lifecycleRevision: "target-revision",
};
const receipt = (
  settled: Promise<SessionEventOutcome>,
  accepted = Promise.resolve({ ok: true as const }),
) => ({ id: "event", cancel: () => false, accepted, settled });

function captureSession(
  accepted?: Promise<{ ok: true }>,
  onEnqueue?: (options: SessionEventOptions) => void,
) {
  const terminal = createDeferred<SessionEventOutcome>();
  const enqueued = createDeferred<SessionEventOptions>();
  fixture.enqueue.mockImplementation((_text, options) => {
    onEnqueue?.(options);
    enqueued.resolve(options);
    return receipt(terminal.promise, accepted);
  });
  return { terminal, enqueued };
}

function input(): Parameters<typeof runCronSessionTurn>[0] {
  return {
    occurrence: TEST_SCHEDULED_OCCURRENCE,
    cfg: fixture.config,
    agentId: "main",
    sessionKey: target.sessionKey,
    admissionSource: "requester-schedule",
    deliveryAttemptFence: null,
    text: "Check the report.",
    job: {
      ...makeCronJob({
        sessionTarget: "session:agent:main:scheduled",
        delivery: { mode: "none" },
      }),
      operatorSource: {
        executionRevision: "original-definition",
        source: {
          version: 1,
          agentId: "main",
          ...target,
          sourceRunId: "original-request",
          snapshot: {
            ...expectDefined(
              createOperatorRecoveryAuthority("requester", "original-grant").recoverySnapshot,
              "operator recovery fixture",
            ),
            controlUiAdmin: true,
          },
        },
      },
    },
    prepare: vi.fn(async () => {}),
    assertCurrent: vi.fn(() => {}),
  };
}

function restoredSource(): RestoredGatewayOperatorAuthority {
  return {
    authority: {
      profileId: "requester",
      scopes: ["operator.read"],
      assertCurrent: vi.fn(() => {}),
    },
    assertPolicyCurrent: vi.fn(),
    authenticatedUserProfile: {
      profileId: "requester",
      displayName: null,
      avatarRevision: "0",
      hasAvatar: false,
      updatedAt: 0,
    },
    controlUiAdmin: true,
    release: vi.fn(),
  };
}

async function prepareLivePrompt(
  params: Parameters<typeof runCronSessionTurn>[0],
  beforePrepare?: () => void,
) {
  const { terminal, enqueued } = captureSession();
  const run = runCronSessionTurn(params);
  try {
    const options = await awaitGateBeforeSettlement(
      enqueued.promise,
      run,
      "settled before enqueue",
    );
    beforePrepare?.();
    return await options.scheduledAutomation?.preparePrompt?.(params.cfg);
  } finally {
    terminal.resolve({ status: "completed", executionStarted: true, delivered: false });
    await run;
  }
}

describe("scheduled session prompts", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T16:00:00Z"));
    fixture.enqueue.mockReturnValue(
      receipt(Promise.resolve({ status: "completed", executionStarted: true, delivered: false })),
    );
  });

  it("resolves store off-thread before submitting localized job context", async () => {
    await withOpenClawTestState({ label: "cron-session-store-path" }, async (state) => {
      const storePath = state.statePath("cron", "jobs.json");
      await writeConfigMachineStateAsync("cron.store", storePath, { env: state.env });
      const observation = observeSqliteReadSql(StatementSync.prototype);
      try {
        const params = input();
        params.cfg = { agents: { defaults: { userTimezone: "America/Los_Angeles" } } };
        const text = await prepareLivePrompt(params, () => {
          vi.setSystemTime(new Date("2026-10-20T16:10:00Z"));
        });
        expect(text).toContain("[cron:job-1 test] Check the report.");
        expect(text).toMatch(/Current time: .*9:00.*\(America\/Los_Angeles\)/);
        expect(text).toContain("Reference UTC: 2026-10-20 16:00 UTC");
        expect(observation.queries.filter((sql) => sql.includes('"config_machine_state"'))).toEqual(
          [],
        );
        expect(fixture.readScratch.mock.calls[0]?.[0]).toBe(storePath);
        fixture.readScratch.mockClear();
        const prepared = input();
        prepared.cfg = params.cfg;
        prepared.sessionPreparation = {
          agentId: prepared.agentId,
          sessionKey: prepared.sessionKey,
          notices: await prepareAutomationSystemEvents(
            prepared.sessionKey,
            prepared.job.id,
            prepared.job.state.runningAtMs,
          ),
          scratch: {
            currentRevision: 1,
            scratch: { content: "Prepared proof scratch", revision: 1, updatedAtMs: 1 },
          },
        };
        expect(await prepareLivePrompt(prepared)).toContain("Prepared proof scratch");
        expect(fixture.readScratch).not.toHaveBeenCalled();
      } finally {
        observation.restore();
      }
    });
  });

  it.each([
    { mode: "announce", messageToolAvailable: true },
    { mode: "announce", messageToolAvailable: false },
    { mode: "none", messageToolAvailable: true },
    { mode: "none", messageToolAvailable: false },
  ] as const)(
    "finalizes $mode delivery guidance with message tool available=$messageToolAvailable",
    async ({ mode, messageToolAvailable }) => {
      const deliveryPlan = {
        source: "delivery" as const,
        mode,
        requested: mode === "announce",
      };
      const resolvedDelivery = {
        ok: true as const,
        mode: "explicit" as const,
        channel: "telegram",
        to: "scheduled-chat",
        accountId: "scheduled-account",
        threadId: "42",
      };
      fixture.delivery.mockResolvedValue({
        deliveryPlan,
        deliveryRequested: deliveryPlan.requested,
        resolvedDelivery,
        sourceDelivery: resolveCronSourceDeliveryPlan({ deliveryPlan, resolvedDelivery }),
        deliverySystemPrompt:
          mode === "announce" ? "Routed formatting already supplied" : undefined,
        messageToolFormatPrompt: mode === "none" ? "Message-only channel formatting" : undefined,
      });
      const params = input();
      params.job.delivery = { mode, channel: "telegram", to: "scheduled-chat" };
      await runCronSessionTurn(params);
      const options = fixture.enqueue.mock.calls[0]?.[1];
      const candidatePrompt = "Instructions after candidate preparation";
      const prompt =
        options?.scheduledAutomation?.finalizePromptForResolvedTools?.({
          prompt: candidatePrompt,
          messageToolAvailable,
        }) ?? candidatePrompt;
      expect(prompt).toContain(candidatePrompt);
      expect(prompt).not.toContain("Routed formatting already supplied");
      if (mode === "announce") {
        expect(prompt).toContain("delivered automatically");
        if (messageToolAvailable) {
          expect(prompt).toContain("with an explicit target");
          expect(prompt).toContain('"target":"scheduled-chat"');
          expect(prompt).toContain('"accountId":"scheduled-account"');
          expect(prompt).toContain('"threadId":"42"');
        } else {
          expect(prompt).not.toContain("Use the message tool");
          expect(prompt).not.toContain("Message delivery destination metadata");
        }
      } else if (messageToolAvailable) {
        expect(prompt).toContain("Message-only channel formatting");
        expect(prompt).not.toContain("delivered automatically");
      } else {
        expect(prompt).toBe(candidatePrompt);
      }
    },
  );

  it.each([
    ["hook:gmail:message", "Email"],
    ["agent:main:hook:gmail:message", "Email"],
    ["agent:main:hook:custom:message", "Webhook"],
  ])(
    "wraps legacy external content sent to %s without an explicit source marker",
    async (sessionKey, source) => {
      const params = input();
      params.sessionKey = sessionKey;
      params.job.sessionTarget = `session:${sessionKey}`;
      const text = await prepareLivePrompt(params);
      expect(text).toContain(`Source: ${source}`);
      expect(text).toMatch(
        /<<<EXTERNAL_UNTRUSTED_CONTENT id="[^"]+">>>[\s\S]*Check the report\.[\s\S]*<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[^"]+">>>[\s\S]*This is an unattended scheduled run/,
      );
      expect(text).not.toContain("the job's instructions win");
      expect(text).not.toContain("remove it if your available tools allow");
    },
  );

  it("honors the existing Gmail unsafe-content opt-in without granting trusted job guidance", async () => {
    const params = input();
    params.sessionKey = "agent:main:hook:gmail:message";
    params.job.sessionTarget = `session:${params.sessionKey}`;
    params.cfg = { hooks: { gmail: { allowUnsafeExternalContent: true } } };
    const text = await prepareLivePrompt(params);
    expect(text).toContain("[cron:job-1 test] Check the report.");
    expect(text).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(text).not.toContain("the job's instructions win");
  });
});

describe("scheduled session execution custody", () => {
  it("times out adopted preparation without spending the setup budget in the queue", async () => {
    vi.useFakeTimers();
    const { terminal, enqueued } = captureSession(undefined, (options) => {
      options.scheduledAutomation?.onLaneWait?.({ waiting: true });
    });
    const triggerTimeout = vi.fn();
    const watchdog = createCronAgentWatchdog({
      deferUntilRunner: true,
      jobTimeoutMs: 180_001,
      triggerTimeout,
    });
    watchdog.start();
    const run = runCronSessionTurn({
      ...input(),
      onLaneWait: (info) => {
        if (info?.waiting === false) {
          watchdog.noteLaneAdmitted();
        } else {
          watchdog.noteLaneWait();
        }
      },
      onExecutionStarted: watchdog.noteRunnerStarted,
    });
    try {
      const options = await awaitGateBeforeSettlement(
        enqueued.promise,
        run,
        "settled before enqueue",
      );
      await vi.advanceTimersByTimeAsync(120_000);
      expect(triggerTimeout).not.toHaveBeenCalled();
      options.scheduledAutomation?.onLaneWait?.({ waiting: false });
      // The controller has the turn, but workspace/account preparation never finishes.
      await vi.advanceTimersByTimeAsync(59_999);
      expect(triggerTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(triggerTimeout).toHaveBeenCalledExactlyOnceWith(
        "cron: isolated agent setup timed out before runner start",
      );
    } finally {
      terminal.resolve({ status: "cancelled", executionStarted: false, delivered: false });
      await run;
      watchdog.dispose();
    }
  });

  it("retains the restored source after acceptance until the controller settles", async () => {
    const source = restoredSource();
    fixture.restore.mockResolvedValue(source);
    const accepted = createDeferred<{ ok: true }>();
    const { terminal, enqueued } = captureSession(accepted.promise);
    const onExecutionStarted = vi.fn();
    const run = runCronSessionTurn({ ...input(), onExecutionStarted });
    const options = await awaitGateBeforeSettlement(
      enqueued.promise,
      run,
      "settled before enqueue",
    );
    accepted.resolve({ ok: true });
    await accepted.promise;
    expect(source.release).not.toHaveBeenCalled();
    expect(options.scheduledAutomation?.operatorAuthority).toBe(source.authority);
    expect(options.scheduledAutomation?.controlUiAdmin).toBe(true);
    expect(options.scheduledAutomation?.admissionSource).toBe("requester-schedule");
    options.scheduledAutomation?.onExecutionStarted?.({
      runId: "scheduled-run",
      sessionId: "target-session",
      sessionKey: "agent:main:scheduled",
    });
    terminal.resolve({
      status: "completed",
      executionStarted: true,
      delivered: false,
      summary: "Report checked.",
      nextCheckMs: 120_000,
    });
    await expect(run).resolves.toMatchObject({
      status: "ok",
      summary: "Report checked.",
      sessionId: "target-session",
      sessionKey: "agent:main:scheduled",
      nextCheck: { delayMs: 120_000 },
    });
    expect(source.release).toHaveBeenCalledOnce();
    expect(onExecutionStarted).toHaveBeenCalledOnce();
  });

  it.each(["failed", "cancelled"] as const)(
    "records controller %s as error and releases the restored source",
    async (status) => {
      const source = restoredSource();
      fixture.restore.mockResolvedValue(source);
      fixture.enqueue.mockReturnValue(
        receipt(Promise.resolve({ status, executionStarted: false, delivered: false })),
      );
      await expect(runCronSessionTurn(input())).resolves.toMatchObject({ status: "error" });
      expect(source.release).toHaveBeenCalledOnce();
    },
  );

  it("refuses a source revoked while restoration was awaited", async () => {
    const source = restoredSource();
    const restoring = createDeferred();
    const restored = createDeferred<RestoredGatewayOperatorAuthority>();
    fixture.restore.mockImplementation(() => {
      restoring.resolve();
      return restored.promise;
    });
    const run = runCronSessionTurn(input());
    await awaitGateBeforeSettlement(restoring.promise, run, "settled before restoring source");
    vi.mocked(source.authority.assertCurrent).mockImplementation(() => {
      throw new Error("original requester revoked");
    });
    restored.resolve(source);
    await expect(run).rejects.toThrow("original requester revoked");
    expect(fixture.enqueue).not.toHaveBeenCalled();
    expect(source.release).toHaveBeenCalledOnce();
  });
});
