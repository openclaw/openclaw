import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureCronMutationCommit } from "../../cron/mutation-completion.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";

const mocks = vi.hoisted(() => ({ context: {} as GatewayRequestContext, dispatch: vi.fn() }));
vi.mock("../../gateway/method-scopes.js", () => ({
  resolveLeastPrivilegeOperatorScopesForMethod: () => ["operator.write"],
}));
vi.mock("../../gateway/server-plugin-in-process-dispatch.js", () => ({
  dispatchGatewayMethodInProcess: mocks.dispatch,
  getInProcessGatewayRequestContext: (resolve?: () => GatewayRequestContext | undefined) =>
    resolve ? resolve() : mocks.context,
  runWithOperatorToolGatewayCleanupContext: <T>(run: () => T) => run(),
}));
vi.mock("./gateway.js", () => ({ callGatewayTool: vi.fn() }));
vi.mock("../../gateway/call.js", () => ({ callGateway: vi.fn() }));

import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";

function createCaller(request: Parameters<typeof callAgentToolGatewayRequest>[0]) {
  let current = true;
  return {
    revoke: () => {
      current = false;
    },
    invoke: () =>
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:caller",
          operationalRunInstance: { instanceId: "caller-instance", runId: "caller-run" },
          receiptAuthority: () => current,
        },
        () => callAgentToolGatewayRequest(request),
      ),
  };
}

describe("Cron mutation completion through in-process Gateway", () => {
  beforeEach(() => mocks.dispatch.mockReset().mockResolvedValue({ ok: true }));

  it.each([
    ...["cron.add", "cron.update", "cron.remove", "cron.run", "cron.scratch.set"].map(
      (method) => [method, { committed: true }, true] as const,
    ),
    ["cron.add", { created: false, updated: false, job: { id: "existing" } }, false],
    ["cron.add", { created: true, job: { id: "unattested" } }, false],
    ["cron.update", { id: "unattested" }, false],
    ["cron.remove", { ok: true, removed: false }, false],
    ["cron.scratch.set", { ok: true, currentRevision: 0, scratch: null }, false],
    ["cron.scratch.set", { ok: false, reason: "revision-conflict", currentRevision: 1 }, false],
    ["cron.run", { ok: true, ran: false, reason: "already-running" }, false],
    ...[false, true].map(
      (committed) => ["cron.remove", new Error("mutation detail"), committed] as const,
    ),
    ["cron.get", { privateJob: true }, false],
  ] as const)(
    "settles revoked %s result %o only with a commit receipt: %s",
    async (method, result, committed) => {
      const caller = createCaller({ method, params: method === "cron.get" ? { id: "job" } : {} });
      mocks.dispatch.mockImplementationOnce(async (_method, _params, options) => {
        if (committed) {
          if (!(result instanceof Error)) {
            options.sessionMutationCommitGuard();
          }
          captureCronMutationCommit(method)?.();
        }
        caller.revoke();
        if (result instanceof Error) {
          throw result;
        }
        return result;
      });
      const pending = caller.invoke();
      if (!committed) {
        await expect(pending).rejects.toThrow(/authority.*no longer active/i);
      } else if (result instanceof Error) {
        await expect(pending).rejects.toBe(result);
      } else {
        await expect(pending).resolves.toEqual(result);
      }
    },
  );

  it.each(["committed", "committed-error", "no-op"] as const)(
    "settles %s Cron work when its request is cancelled after the owner returns",
    async (outcome) => {
      const controller = new AbortController();
      const cleanupError = new Error("committed mutation cleanup failed");
      mocks.dispatch.mockImplementationOnce(async (_method, _params, options) => {
        expect(options.signal).toBeUndefined();
        options.sessionMutationCommitGuard();
        if (outcome !== "no-op") {
          captureCronMutationCommit("cron.add")?.();
        }
        controller.abort(new Error("creator request cancelled"));
        if (outcome === "committed-error") {
          throw cleanupError;
        }
        return { created: outcome === "committed" };
      });
      const result = callAgentToolGatewayRequest({
        method: "cron.add",
        params: {},
        signal: controller.signal,
      });
      if (outcome === "committed") {
        await expect(result).resolves.toEqual({ created: true });
      } else if (outcome === "committed-error") {
        await expect(result).rejects.toBe(cleanupError);
      } else {
        await expect(result).rejects.toThrow("creator request cancelled");
      }
    },
  );

  it("keeps Cron cancellation in the mutation owner's pre-commit fence", async () => {
    const controller = new AbortController();
    const commit = vi.fn();
    mocks.dispatch.mockImplementationOnce(async (_method, _params, options) => {
      controller.abort(new Error("cancelled before commit"));
      options.sessionMutationCommitGuard();
      commit();
      return { created: true };
    });
    await expect(
      callAgentToolGatewayRequest({
        method: "cron.add",
        params: {},
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled before commit");
    expect(commit).not.toHaveBeenCalled();
  });

  it("does not let a late receipt mark a successor invocation", async () => {
    let previousCommit: (() => undefined) | undefined;
    mocks.dispatch.mockImplementationOnce(async () => {
      previousCommit = captureCronMutationCommit("cron.add");
      return { created: false, updated: false, job: { id: "previous" } };
    });
    await callAgentToolGatewayRequest({ method: "cron.add", params: {} });
    expect(previousCommit).toBeTypeOf("function");
    const caller = createCaller({ method: "cron.add", params: {} });
    mocks.dispatch.mockImplementationOnce(async () => {
      expect(captureCronMutationCommit("cron.remove")).toBeUndefined();
      previousCommit?.();
      caller.revoke();
      return { id: "successor" };
    });
    await expect(caller.invoke()).rejects.toThrow(/authority.*no longer active/i);
  });
});
