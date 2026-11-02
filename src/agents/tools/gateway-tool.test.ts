import { asRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareCronRunAdmission } from "../../cron/run-admission.js";
import { TEST_SCHEDULED_EXECUTION } from "../../cron/scheduled-occurrence.test-support.js";
import { restartHandlers } from "../../gateway/server-methods/restart.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  resetGatewayRestartStateForInProcessRestart,
  setPreRestartDeferralCheck,
} from "../../infra/restart.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { createGatewayTool } from "./gateway-tool.js";

const { callGatewayToolMock, dispatchMock, host } = vi.hoisted(() => ({
  dispatchMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  host: { context: {} as GatewayRequestContext | undefined },
  callGatewayToolMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true })),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
  readGatewayCallOptions: vi.fn(() => ({})),
}));

vi.mock("../../gateway/server-plugin-in-process-dispatch.js", () => ({
  dispatchGatewayMethodInProcess: dispatchMock,
  getInProcessGatewayRequestContext: (resolve?: () => GatewayRequestContext | undefined) =>
    resolve ? resolve() : host.context,
}));
const ownerTool = () => createGatewayTool({ senderIsOwner: true, allowConfigReads: false });
const expectNoGatewayCall = () => {
  expect(callGatewayToolMock).not.toHaveBeenCalled();
  expect(dispatchMock).not.toHaveBeenCalled();
};

describe("gateway tool", () => {
  beforeEach(() => {
    callGatewayToolMock.mockReset();
    dispatchMock.mockReset();
    callGatewayToolMock.mockResolvedValue({ ok: true });
  });

  it.each(["config.schema.lookup"])(
    "rejects %s without config read authority before calling the Gateway",
    async (action) => {
      const tool = createGatewayTool({ allowConfigReads: false, senderIsOwner: true });

      await expect(tool.execute("denied-config", { action, path: "channels" })).rejects.toThrow(
        `Action not available: ${action}`,
      );
      expectNoGatewayCall();
    },
  );

  it("hands an owner restart to the real runtime scheduler and waits for active work", async () => {
    vi.useFakeTimers();
    resetGatewayRestartStateForInProcessRestart();
    resetGatewayWorkAdmission();
    let pending = 1;
    setPreRestartDeferralCheck(() => pending);
    const restarted = vi.fn();
    process.on("SIGUSR2", restarted);
    dispatchMock.mockImplementation(async (method, params, options) => {
      const handler = restartHandlers[String(method)];
      if (!handler) {
        throw new Error("Unexpected maintenance method");
      }
      let result: unknown;
      await handler({
        params,
        sessionMutationCommitGuard: (options as { sessionMutationCommitGuard?: () => void })
          .sessionMutationCommitGuard,
        respond: (ok, payload, error) => {
          if (!ok) {
            throw new Error(error?.message);
          }
          result = payload;
        },
      } as Parameters<typeof handler>[0]);
      return result;
    });
    try {
      const result = await ownerTool().execute("maintenance", {
        action: "restart",
        note: "update.run",
        skipDeferral: true,
        target: { pid: 1 },
        gatewayUrl: "wss://wrong.invalid",
      });
      expect(result.details).toMatchObject({
        ok: true,
        restart: { mode: "emit", reason: "gateway.restart.agent" },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(restarted).not.toHaveBeenCalled();
      pending = 0;
      await vi.advanceTimersByTimeAsync(500);
      expect(restarted).toHaveBeenCalledOnce();
      expect(callGatewayToolMock).not.toHaveBeenCalled();
    } finally {
      process.off("SIGUSR2", restarted);
      resetGatewayRestartStateForInProcessRestart();
      setPreRestartDeferralCheck(() => 0);
      resetGatewayWorkAdmission();
      vi.useRealTimers();
    }
  });

  it.each(["restart", "update.cleanup"])(
    "refuses non-owner %s before any effect",
    async (action) => {
      const result = await createGatewayTool({ senderIsOwner: false }).execute("maintenance", {
        action,
        senderIsOwner: true,
      });
      expect(result.details).toMatchObject({ ok: false, code: "owner_required" });
      expectNoGatewayCall();
    },
  );
});

describe("gateway maintenance authority", () => {
  it.each(["restart", "update.cleanup"])(
    "does not redirect %s to a remote Gateway",
    async (action) => {
      host.context = undefined;
      dispatchMock.mockReset();
      callGatewayToolMock.mockClear();
      await expect(
        createGatewayTool({ senderIsOwner: true }).execute("maintenance", {
          action,
          gatewayUrl: "wss://other.invalid",
          gatewayToken: "synthetic-token",
        }),
      ).rejects.toThrow("Gateway instance unavailable");
      expectNoGatewayCall();
    },
  );
});

describe("gateway update action", () => {
  beforeEach(() => {
    callGatewayToolMock.mockReset();
    dispatchMock.mockReset();
    host.context = {} as GatewayRequestContext;
  });

  it("refuses scheduler-source injection inside a live non-scheduler run", async () => {
    const sessionKey = "agent:main:operator";
    const admission = prepareSystemAgentRunAdmission({}, "operator-run", "main", "test");
    try {
      const context = await admission.admit("embedded");
      bindGatewayContextResolver(context, () => host.context);
      const caller = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: context,
        agentId: "main",
        sessionKey,
      });
      const injectedIdentity = {
        agentId: "main",
        sessionKey,
        admissionSource: "operator-schedule" as const,
      };
      dispatchMock.mockResolvedValue({ ok: true, result: { status: "ok" } });
      const result = await withGatewayToolCallerIdentity(caller, () =>
        withGatewayToolCallerIdentity(injectedIdentity, () => {
          expect(getGatewayToolCallerIdentity()?.approvalAuthority).toBe(caller?.approvalAuthority);
          return createGatewayTool().execute("injected-update", { action: "update.run" });
        }),
      );
      expect(result.details).toMatchObject({
        ok: false,
        code: "owner_required",
        reason: "owner_required",
      });
      expect(dispatchMock).not.toHaveBeenCalled();
    } finally {
      admission.close();
    }
  });

  it.each(["operator-schedule", "requester-schedule"] as const)(
    "uses recorded scheduler admission %s independently of audit and chat delivery",
    async (admissionSource) => {
      const sessionKey = "agent:main:synthetic-update";
      const admission = prepareCronRunAdmission({
        scheduledExecution: TEST_SCHEDULED_EXECUTION,
        deliveryAttemptFence: { beforeAttempt: async () => {}, assertCurrent: () => {} },
        cfg: {},
        agentId: "main",
        runId: "synthetic-run",
        sessionId: "synthetic-session",
        sessionKey,
        jobId: "synthetic-job",
        admissionSource,
      });
      try {
        const context = await admission.preparedRunAdmission.admit("embedded");
        expect(context.executionIdentityToken).toBeUndefined();
        bindGatewayContextResolver(context, () => host.context);
        const caller = createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: context,
          agentId: "main",
          sessionKey,
          turnSourceChannel: "telegram",
          turnSourceTo: "123",
        });
        dispatchMock.mockResolvedValue({ ok: true, runId: "update-run", result: { status: "ok" } });
        const invoke = () =>
          withGatewayToolCallerIdentity(caller, () =>
            withGatewayToolCallerIdentity({ agentId: "main", sessionKey }, () =>
              createGatewayTool().execute("scheduled-update", { action: "update.run" }),
            ),
          );
        const result = await invoke();
        if (admissionSource === "operator-schedule") {
          expect(result.details).toMatchObject({ ok: true, runId: "update-run" });
          expect(dispatchMock).toHaveBeenCalledOnce();
          expect(dispatchMock.mock.calls[0]?.[1]).toMatchObject({
            sessionKey,
            requester: undefined,
            deliveryContext: { channel: "telegram", to: "123" },
          });
          admission.close();
          expect((await invoke()).details).toMatchObject({
            ok: false,
            code: "owner_required",
            reason: "owner_required",
          });
          expect(dispatchMock).toHaveBeenCalledOnce();
        } else {
          expect(result.details).toMatchObject({
            ok: false,
            code: "owner_required",
            reason: "owner_required",
            message: expect.stringContaining(
              "No authenticated owner chat principal or operator-scheduled admission",
            ),
          });
          expect(dispatchMock).not.toHaveBeenCalled();
        }
      } finally {
        admission.close();
      }
    },
  );

  it("requires an explicit owner identity", async () => {
    const result = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:123456789",
        turnSourceChannel: "telegram",
      },
      () =>
        createGatewayTool({ requesterSenderId: "123456789" }).execute("update", {
          action: "update.run",
          requesterSenderId: "spoofed",
          channel: "discord",
        }),
    );
    expect(result.details).toEqual({
      ok: false,
      code: "owner_required",
      reason: "owner_required",
      message:
        "No authenticated owner chat principal or operator-scheduled admission authorizes this update. Ask the operator to add `telegram:123456789` to `commands.ownerAllowFrom`.",
    });
    expectNoGatewayCall();
  });

  it.each([0])(
    "uses trusted chat routing without an update deadline (thread %s)",
    async (threadId) => {
      dispatchMock.mockResolvedValue({
        ok: true,
        result: {
          status: "skipped",
          mode: "npm",
          reason: "managed-service-update-handoff",
          before: { version: "2026.9.1" },
        },
        handoff: { status: "started", command: "openclaw update --timeout 1200", pid: 123 },
        restart: { ok: true, delayMs: 2000, pid: 456 },
        sentinel: { payload: "private-runtime-state" },
        ackDelivered: true,
      });
      const signal = new AbortController().signal;
      const result = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:telegram:direct:123",
          turnSourceChannel: "telegram",
          turnSourceTo: "123",
          turnSourceAccountId: "primary",
          turnSourceThreadId: threadId,
        },
        () =>
          createGatewayTool({ senderIsOwner: true, requesterSenderId: "owner" }).execute(
            "update",
            {
              action: "update.run",
              note: "Requested update",
              sessionKey: "spoofed",
              deliveryContext: { channel: "discord", to: "other" },
              gatewayUrl: "wss://other.example",
              gatewayToken: "model-token",
              timeoutMs: 1,
            },
            signal,
          ),
      );
      expect(dispatchMock).toHaveBeenCalledExactlyOnceWith(
        "update.run",
        {
          requester: { channel: "telegram", accountId: "primary", senderId: "owner" },
          sessionKey: "agent:main:telegram:direct:123",
          deliveryContext: {
            channel: "telegram",
            to: "123",
            accountId: "primary",
            threadId,
          },
          note: "Requested update",
        },
        {
          signal,
          timeoutMs: 1_200_000,
          forceSyntheticClient: true,
          operatorRoleActor: { kind: "system" },
          syntheticScopes: ["operator.admin"],
          syntheticScopeMode: "minimum",
          resolveGatewayContext: expect.any(Function),
        },
      );
      expect(callGatewayToolMock).not.toHaveBeenCalled();
      expect(result.details).toMatchObject({
        ok: true,
        status: "skipped",
        before: { version: "2026.9.1" },
        restart: { scheduled: true, delayMs: 2000 },
        ackDelivered: true,
        failedSteps: [],
      });
      const serialized = JSON.stringify(result.details);
      expect(serialized).not.toContain("sentinel");
      expect(serialized).not.toContain('"pid"');
      expect(serialized).toContain("do not run shell commands or restart anything");
    },
  );

  it("still calls without a caller session", async () => {
    dispatchMock.mockResolvedValue({ ok: true, result: { status: "ok", steps: [] } });
    const result = await ownerTool().execute("update", {
      action: "update.run",
    });
    expect(dispatchMock).toHaveBeenCalledOnce();
    expect(callGatewayToolMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ ok: true });
  });

  it("refuses an update without a hosting gateway instead of using a remote client", async () => {
    host.context = undefined;
    await expect(
      createGatewayTool({ senderIsOwner: true }).execute("update", { action: "update.run" }),
    ).rejects.toThrow("Gateway instance unavailable for update.run");
    expectNoGatewayCall();
  });

  it("preserves update diagnostic Unicode in tool results", async () => {
    const reason = "r".repeat(239);
    const name = "n".repeat(99);
    const stderrTail = "s".repeat(499);
    dispatchMock.mockResolvedValue({
      ok: false,
      result: {
        status: "error",
        reason: `${reason}🤖`,
        before: { version: `${name}🤖` },
        after: { version: `${name}🤖` },
        steps: [{ name: `${name}🤖`, exitCode: 1, stderrTail: `🤖${stderrTail}` }],
      },
    });
    const result = await createGatewayTool({ senderIsOwner: true }).execute("update", {
      action: "update.run",
    });
    expect(dispatchMock).toHaveBeenCalledOnce();
    expect(callGatewayToolMock).not.toHaveBeenCalled();
    const reasonText = readStringField(asRecord(result.details), "reason");
    expect(reasonText?.charCodeAt(reasonText.length - 1), "UPDATE_DIAGNOSTIC_UTF16_BOUNDARY").toBe(
      reason.charCodeAt(reason.length - 1),
    );
    expect(result.details).toMatchObject({
      reason,
      before: { version: name },
      after: { version: name },
      failedSteps: [{ name, exitCode: 1, stderrTail }],
    });
    const text = result.content.find((block) => block.type === "text");
    expect(text?.type === "text" && JSON.parse(text.text)).toEqual(result.details);
  });
});
