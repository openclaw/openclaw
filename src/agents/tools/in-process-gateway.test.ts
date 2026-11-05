import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { captureCronMutationCommit } from "../../cron/mutation-completion.js";
import { readInProcessAgentRuntimeIdentity } from "../../gateway/in-process-agent-runtime-identity.js";
import {
  bindInProcessSessionDeliveryGeneration,
  readInProcessSessionDeliveryGeneration,
} from "../../gateway/in-process-session-delivery.js";
import {
  bindInProcessSubagentResume,
  readInProcessSubagentResume,
} from "../../gateway/in-process-subagent-resume.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../admitted-run-context.js";

const mocks = vi.hoisted(() => ({
  hasContext: true,
  context: {} as GatewayRequestContext,
  dispatch: vi.fn(),
  callGateway: vi.fn(),
  callGatewayTool: vi.fn(),
}));

vi.mock("../../gateway/method-scopes.js", () => ({
  resolveLeastPrivilegeOperatorScopesForMethod: () => ["operator.write"],
}));

vi.mock("../../gateway/server-plugin-in-process-dispatch.js", () => ({
  dispatchGatewayMethodInProcess: mocks.dispatch,
  getInProcessGatewayRequestContext: (resolver?: () => GatewayRequestContext | undefined) =>
    resolver ? resolver() : mocks.hasContext ? mocks.context : undefined,
  runWithOperatorToolGatewayCleanupContext: <T>(run: () => T) => run(),
}));

vi.mock("./gateway.js", () => ({ callGatewayTool: mocks.callGatewayTool }));
vi.mock("../../gateway/call.js", () => ({ callGateway: mocks.callGateway }));

import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { getGatewaySessionSpawnContext } from "./gateway-session-spawn-context.js";
import {
  bindAgentToolGatewayRequest,
  callAgentToolGatewayRequest,
  callInProcessGatewayTool,
  callInProcessGatewayToolWithCreation,
  withAgentToolGatewayRuntimeIdentity,
} from "./in-process-gateway.js";

const mainCaller = { agentId: "main", sessionKey: "agent:main:main" };
const foregroundCaller = {
  ...mainCaller,
  sessionKey: "agent:main:caller",
  operationalRunInstance: { instanceId: "caller-instance", runId: "caller-run" },
};
const runtimeIdentity = {
  kind: "agentRuntime",
  agentId: "main",
  sessionKey: "agent:main:worker",
  operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
  delegatedAuthority: {
    kind: "local",
    lifecycleGeneration: "generation-1",
    claimId: "claim-1",
    operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
  },
} as const;
type Caller = NonNullable<Parameters<typeof withGatewayToolCallerIdentity>[0]>;
function asCaller<T>(identity: Partial<Caller>, run: () => Promise<T>) {
  return withGatewayToolCallerIdentity({ ...mainCaller, ...identity }, run);
}
function gatewayBinding() {
  const admitted = {} as GatewayRequestContext;
  let current = admitted;
  return {
    admitted,
    replace: () => {
      current = {} as GatewayRequestContext;
    },
    resolve: () => current,
  };
}
type Request = Parameters<typeof callAgentToolGatewayRequest>[0];
const callRequest = (
  method: string,
  params: Request["params"] = {},
  options: Omit<Request, "method" | "params"> = {},
) => callAgentToolGatewayRequest({ method, params, ...options });
function expectNoTransport() {
  expect(mocks.callGateway).not.toHaveBeenCalled();
  expect(mocks.callGatewayTool).not.toHaveBeenCalled();
}
function expectDispatch(method: string, params: unknown, options: unknown = expect.anything()) {
  expect(mocks.dispatch).toHaveBeenCalledWith(method, params, options);
}
beforeEach(() => {
  mocks.hasContext = true;
  mocks.dispatch.mockReset().mockResolvedValue({ ok: true });
  mocks.callGateway.mockReset();
  mocks.callGatewayTool.mockReset();
});
function holdCommit() {
  const entered = createDeferred();
  const release = createDeferred();
  const commit = vi.fn();
  mocks.dispatch.mockImplementationOnce(async (_method, _params, options) => {
    entered.resolve();
    await release.promise;
    options.sessionMutationCommitGuard?.();
    commit();
    return { ok: true };
  });
  return { entered: entered.promise, release: () => release.resolve(), commit };
}

describe("trusted in-process Gateway session creation", () => {
  const creation = {
    via: "spawn" as const,
    actor: { type: "agent" as const, id: "main" },
    requesterSessionKey: "agent:main:main",
  };
  const createSession = (
    params: Parameters<typeof callInProcessGatewayToolWithCreation>[1] = { agentId: "main" },
    provenance: Parameters<typeof callInProcessGatewayToolWithCreation>[2] = creation,
    options?: Parameters<typeof callInProcessGatewayToolWithCreation>[3],
  ) => callInProcessGatewayToolWithCreation("sessions.create", params, provenance, options);

  it.each([
    { origin: { delegatedCreatorProfileId: "linked-human" }, expected: "linked-human" },
    {
      origin: { delegatedCreatorProfileId: null, operatorProfileId: "selected-human" },
      expected: undefined,
    },
    { origin: { senderId: "claimed-profile", messageProvider: "x" }, expected: undefined },
  ])(
    "uses only the host causal requester for default task ownership: $expected",
    async ({ origin, expected }) => {
      await asCaller({ requesterOrigin: { sessionKey: mainCaller.sessionKey, ...origin } }, () =>
        createSession(),
      );
      expect(mocks.dispatch.mock.calls[0]?.[2].sessionCreation).toEqual({
        ...creation,
        ...(expected ? { requesterProfileId: expected } : {}),
      });
    },
  );

  const subagentResume = {
    caller: { ...mainCaller, assertCurrent: vi.fn() },
    childSessionKey: "agent:main:dashboard:child",
    childSessionId: "child-session",
    previousRunId: "paused-run",
    taskRunId: "original-task",
    generation: 1,
    createdAt: 100,
  };
  const generation = {
    agentId: "main",
    storePath: "/test/agents/main/sessions/sessions.json",
    sessionKey: "agent:main:main",
    sessionId: "session-one",
    lifecycleRevision: null,
  };

  it.each([
    {
      name: "task resume",
      request: bindInProcessSubagentResume(
        {
          method: "agent",
          params: { message: "Continue", sessionKey: subagentResume.childSessionKey },
        },
        subagentResume,
      ),
      read: readInProcessSubagentResume,
      binding: subagentResume,
      carrierIndex: 2,
      error: "trusted in-process Gateway dispatch",
    },
    {
      name: "session delivery",
      request: {
        method: "send",
        params: bindInProcessSessionDeliveryGeneration(
          { channel: "telegram", to: "recipient", message: "Ready", idempotencyKey: "result-one" },
          generation,
        ),
      },
      read: readInProcessSessionDeliveryGeneration,
      binding: generation,
      carrierIndex: 1,
      error: "Session-bound delivery requires its admitted in-process Gateway",
    },
    {
      name: "runtime identity",
      request: withAgentToolGatewayRuntimeIdentity(
        { method: "chat.send", params: { sessionKey: "agent:main:child" } },
        runtimeIdentity,
      ),
      read: readInProcessAgentRuntimeIdentity,
      binding: runtimeIdentity,
      carrierIndex: 2,
      error: "trusted agent runtime identity requires in-process Gateway dispatch",
    },
  ])(
    "keeps $name private and refuses transport fallback",
    async ({ request, read, binding, carrierIndex, error }) => {
      await callAgentToolGatewayRequest(request);
      expectDispatch(request.method, request.params);
      const carrier = mocks.dispatch.mock.calls[0]?.[carrierIndex];
      if (carrierIndex === 1) {
        expect(read(carrier)).toEqual(binding);
        expect(read({ ...request.params })).toBeUndefined();
      } else {
        expect(read(carrier)).toBe(binding);
      }
      expect(request.params).not.toHaveProperty("subagentResume");
      if (request.method === "chat.send") {
        expect(JSON.stringify(request)).toBe(
          '{"method":"chat.send","params":{"sessionKey":"agent:main:child"}}',
        );
      }
      mocks.hasContext = false;
      await expect(callAgentToolGatewayRequest(request)).rejects.toThrow(error);
      expect(mocks.callGateway).not.toHaveBeenCalled();
    },
  );

  it("uses an explicitly bound Gateway when worker creation has no ambient request scope", async () => {
    mocks.hasContext = false;
    const admitted = {} as GatewayRequestContext;
    const sessionMutationCommitGuard = vi.fn();
    const workerCreation = {
      ...creation,
      requesterSessionKey: "agent:main:dashboard:worker",
      inheritedToolPolicy: { version: 1 as const, allow: ["sessions_spawn"], deny: [] },
    };
    const options = {
      resolveGatewayContext: () => admitted,
      sessionMutationCommitGuard,
      signal: new AbortController().signal,
      timeoutMs: 2_000,
    };
    mocks.dispatch.mockResolvedValueOnce({ key: "agent:main:worker" });
    await expect(createSession(undefined, workerCreation, options)).resolves.toEqual({
      key: "agent:main:worker",
    });
    const dispatchedOptions = mocks.dispatch.mock.calls[0]?.[2];
    expect(dispatchedOptions).toMatchObject({
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    expect(dispatchedOptions.sessionCreation).toEqual(workerCreation);
    expect(dispatchedOptions.resolveGatewayContext()).toBe(admitted);
    expect(() => dispatchedOptions.sessionMutationCommitGuard()).not.toThrow();
    expect(sessionMutationCommitGuard).toHaveBeenCalledOnce();
    const refusal = new Error("worker creation authority retired");
    sessionMutationCommitGuard.mockImplementationOnce(() => {
      throw refusal;
    });
    expect(() => dispatchedOptions.sessionMutationCommitGuard()).toThrow(refusal);
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("carries visible-spawn policy and its timeout through signed fallback dispatch", async () => {
    mocks.hasContext = false;
    const params = {
      agentId: "main",
      parentSessionKey: "agent:main:main",
      spawnDepth: 1,
      model: "custom/middle",
    };
    const spawnContext = {
      requesterSenderIsOwner: true,
      completionOwnerSessionKey: "agent:main:discord:direct:alice",
      inheritedToolPolicy: {
        version: 1 as const,
        allow: ["read", "sessions_spawn"],
        deny: ["exec"],
      },
      resolvedModel: { provider: "custom", model: "middle" },
      spawnModelAutoSelection: { model: "custom/middle", hasFallbackOrigin: true },
    };
    mocks.callGatewayTool.mockImplementationOnce(async () => {
      expect(getGatewaySessionSpawnContext()).toEqual(spawnContext);
      return { key: "agent:main:dashboard:child" };
    });
    await createSession({ ...params }, { ...creation, ...spawnContext }, { timeoutMs: 120_000 });

    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "sessions.create",
      { timeoutMs: 120_000 },
      params,
      { scopes: ["operator.write"], requireAgentRuntimeIdentity: true },
    );
    expect(getGatewaySessionSpawnContext()).toBeUndefined();
  });

  it("retains the generic helper's transport fallback", async () => {
    mocks.hasContext = false;
    const signal = new AbortController().signal;
    await callInProcessGatewayTool("sessions.list", { limit: 5 }, { timeoutMs: 120_000, signal });
    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "sessions.list",
      { timeoutMs: 120_000 },
      { limit: 5 },
      { scopes: ["operator.write"], signal },
    );
  });

  it("refuses creation transport before forwarding admitted operator authority", async () => {
    mocks.hasContext = false;
    await expect(
      asCaller(
        {
          operatorAuthority: createAdmittedRunOperatorAuthority({
            profileId: "operator",
            scopes: ["operator.write"],
            assertCurrent: () => {},
          }),
        },
        () =>
          createSession(undefined, {
            ...creation,
            inheritedToolPolicy: { version: 1, allow: ["read"], deny: [] },
          }),
      ),
    ).rejects.toThrow("operator run authority requires its admitted Gateway");
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expectNoTransport();
  });
});

describe("request-shaped in-process Gateway dispatch", () => {
  it("marks only an owner-bound plugin approval request for host admission", async () => {
    const identity = {
      ...runtimeIdentity,
      sessionKey: "agent:main:main",
      approvalOwnerPluginId: "registered-hook",
    } as const;
    const request = (method: string) =>
      callAgentToolGatewayRequest(
        withAgentToolGatewayRuntimeIdentity({ method, params: {} }, identity),
      );
    await request("plugin.approval.request");

    const requestOptions = mocks.dispatch.mock.calls[0]?.[2];
    expect(requestOptions).toMatchObject({ allowHostPluginApprovalRequest: true });
    expect(readInProcessAgentRuntimeIdentity(requestOptions)).toBe(identity);

    await request("plugin.approval.resolve");
    expect(mocks.dispatch.mock.calls[1]?.[2]).not.toHaveProperty("allowHostPluginApprovalRequest");
  });

  it.each([
    [undefined, 10_000],
    [null, undefined],
    [0, 0],
  ] as const)(
    "preserves request options and maps timeout %s to %s",
    async (timeoutMs, expected) => {
      const params = { sessionKey: "agent:main:worker", message: "run" };
      const options = {
        agentToolCaller: mainCaller,
        replyExpectation: "optional" as const,
        expectFinal: true,
        onAccepted: vi.fn(),
        signal: new AbortController().signal,
      };
      await callRequest("agent", { ...params }, { ...options, timeoutMs });

      expectDispatch("agent", params, {
        ...options,
        forceSyntheticClient: true,
        operatorRoleActor: { kind: "system" },
        resolveGatewayContext: expect.any(Function),
        syntheticScopeMode: "minimum",
        syntheticScopes: ["operator.write"],
        ...(expected === undefined ? {} : { timeoutMs: expected }),
      });
      expect(mocks.callGateway).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "allows closed-caller abort cleanup only on the original Gateway (replaced=%s)",
    async (replaced) => {
      const gateway = gatewayBinding();
      let currentCaller = true;
      let cancelled = false;
      const controller = new AbortController();
      const params = { turnId: replaced ? "turn-1" : "owned-turn" };
      mocks.dispatch.mockImplementation(async (method, _params, options) => {
        if (method === "conversations.turn.cancel") {
          expect(options.resolveGatewayContext()).toBe(gateway.admitted);
          expect(readInProcessAgentRuntimeIdentity(options)).toBeUndefined();
          cancelled = true;
          return { ok: true };
        }
        if (replaced) {
          gateway.replace();
        } else {
          currentCaller = false;
          controller.abort();
        }
        await options.onSignalAbort();
        throw new Error("primary aborted");
      });
      const pending = asCaller(
        {
          ...(replaced ? mainCaller : foregroundCaller),
          ...(!replaced
            ? { receiptAuthority: () => currentCaller, approvalSignals: [controller.signal] }
            : {}),
          gatewayContextResolver: gateway.resolve,
        },
        () =>
          callRequest("conversations.turn", params, {
            ...(!replaced ? { signal: controller.signal } : {}),
            onSignalAbort: async (request) => {
              await request("conversations.turn.cancel", params);
            },
          }),
      );
      if (replaced) {
        await expect(pending).rejects.toThrow("Gateway instance unavailable");
      } else {
        await expect(pending).rejects.toThrow();
      }
      expect(cancelled).toBe(!replaced);
      expect(mocks.dispatch.mock.calls.map(([method]) => method)).toEqual(
        replaced ? ["conversations.turn"] : ["conversations.turn", "conversations.turn.cancel"],
      );
      if (replaced) {
        expect(mocks.callGateway).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["dispatch", "resolve", "reject"] as const)(
    "keeps an operation on its admitted Gateway through %s",
    async (boundary) => {
      const gateway = gatewayBinding();
      const request = bindAgentToolGatewayRequest({ resolveGatewayContext: gateway.resolve });
      const settled = createDeferred();
      mocks.dispatch.mockImplementationOnce(async (_method, _params, options) => {
        expect(options.resolveGatewayContext()).toBe(gateway.admitted);
        return await settled.promise;
      });
      if (boundary === "dispatch") {
        gateway.replace();
      }
      const pending = request({ method: "question.resolve", params: { id: "question-1" } });
      if (boundary !== "dispatch") {
        await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledOnce());
        gateway.replace();
        if (boundary === "resolve") {
          settled.resolve();
        } else {
          settled.reject(new Error("inner dispatch failed"));
        }
      }
      await expect(pending).rejects.toThrow("Gateway instance unavailable");
      expect(mocks.dispatch).toHaveBeenCalledTimes(boundary === "dispatch" ? 0 : 1);
      expectNoTransport();
    },
  );

  it("retains local-embedded transport for hosted-only operation bindings", async () => {
    const context = { localEmbedded: true } as GatewayRequestContext;
    const request = bindAgentToolGatewayRequest({
      resolveGatewayContext: () => context,
      hostedOnly: true,
    });
    await request({ method: "question.get", params: { id: "question-1" } });
    expect(mocks.callGateway).toHaveBeenCalledOnce();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "composes dispatch custody with an admitted caller before child I/O (caller=%s)",
    async (withCaller) => {
      let current = true;
      const childIo = vi.fn();
      const assertDispatchCurrent = () => {
        if (!current) {
          throw new Error("source authority retired");
        }
      };
      mocks.dispatch.mockImplementationOnce(async (_method, _params, options) => {
        current = false;
        options.sessionMutationCommitGuard();
        childIo();
        return { ok: true };
      });
      const admission = withCaller
        ? prepareSystemAgentRunAdmission({}, "dispatch-requester", "main", "dispatch-guard-proof")
        : undefined;
      try {
        const run = () =>
          callRequest(
            withCaller ? "agent" : "sessions.patch",
            withCaller
              ? { sessionKey: "agent:main:child", message: "Continue the child task" }
              : { key: "target", pinned: true },
            { assertDispatchCurrent },
          );
        const pending = admission
          ? withGatewayToolCallerIdentity(
              createAdmittedGatewayToolCallerIdentity({
                admittedRunContext: await admission.admit("embedded"),
                agentId: "main",
                sessionKey: "agent:main:requester",
              }),
              run,
            )
          : run();
        await expect(pending).rejects.toThrow("source authority retired");
        expect(childIo).not.toHaveBeenCalled();
        expect(mocks.callGateway).not.toHaveBeenCalled();
      } finally {
        admission?.close();
      }
    },
  );

  it("falls back to the original Gateway request outside the Gateway process", async () => {
    mocks.hasContext = false;
    const request = {
      method: "sessions.list",
      params: { limit: 5 },
      timeoutMs: 2_000,
      agentRunTracking: "native_subagent",
      agentToolCaller: {
        agentId: "main",
        sessionKey: "agent:main:discord:direct:colin",
      },
    } as const;

    await callAgentToolGatewayRequest(request);

    const { agentRunTracking: _tracking, agentToolCaller: _caller, ...wireRequest } = request;
    expect(mocks.callGateway).toHaveBeenCalledWith(wireRequest);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});

describe("built-in Gateway foreground authority", () => {
  it.each(["dispatch", "commit"] as const)(
    "rejects retired caller authority before %s",
    async (boundary) => {
      const held = holdCommit();
      let current = true;
      const pending = asCaller(
        { ...foregroundCaller, receiptAuthority: () => current },
        async () => {
          if (boundary === "dispatch") {
            current = false;
          }
          return await callRequest("sessions.patch", { key: "target", pinned: true });
        },
      );
      const rejected = expect(pending).rejects.toThrow(/authority.*no longer active/i);
      if (boundary === "commit") {
        await held.entered;
        current = false;
        held.release();
      }
      await rejected;
      expect(held.commit).not.toHaveBeenCalled();
      if (boundary === "dispatch") {
        expect(mocks.dispatch).not.toHaveBeenCalled();
      }
      expectNoTransport();
    },
  );

  it("keeps a preserved write fenced by its original request signal", async () => {
    const controller = new AbortController();
    const held = holdCommit();
    const pending = bindAgentToolGatewayRequest({ revalidateOnCompletion: false })({
      method: "message.action",
      params: { action: "channel-edit" },
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toThrow("message request canceled");
    try {
      await held.entered;
      controller.abort(new Error("message request canceled"));
      held.release();
      await rejected;
      expect(held.commit).not.toHaveBeenCalled();
    } finally {
      held.release();
      await Promise.allSettled([pending]);
    }
  });
});

function createCaller(request: Parameters<typeof callAgentToolGatewayRequest>[0]) {
  let current = true;
  return {
    revoke: () => {
      current = false;
    },
    invoke: () =>
      asCaller({ ...foregroundCaller, receiptAuthority: () => current }, () =>
        callAgentToolGatewayRequest(request),
      ),
  };
}

describe("Cron mutation completion through in-process Gateway", () => {
  it.each([
    ["cron.run", { committed: true }, true],
    ["cron.add", { created: true, job: { id: "unattested" } }, false],
    ["cron.remove", new Error("mutation detail"), false],
    ["cron.remove", new Error("mutation detail"), true],
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
      const result = callRequest("cron.add", {}, { signal: controller.signal });
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
    await expect(callRequest("cron.add", {}, { signal: controller.signal })).rejects.toThrow(
      "cancelled before commit",
    );
    expect(commit).not.toHaveBeenCalled();
  });

  it("does not let a late receipt mark a successor invocation", async () => {
    let previousCommit: (() => undefined) | undefined;
    mocks.dispatch.mockImplementationOnce(async () => {
      previousCommit = captureCronMutationCommit("cron.add");
      return { created: false, updated: false, job: { id: "previous" } };
    });
    await callRequest("cron.add");
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
