import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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

describe("trusted in-process Gateway session creation", () => {
  const creation = {
    via: "spawn" as const,
    actor: { type: "agent" as const, id: "main" },
    requesterSessionKey: "agent:main:main",
  };
  beforeEach(() => {
    mocks.hasContext = true;
    mocks.dispatch.mockReset().mockResolvedValue({ key: "agent:main:dashboard:child" });
    mocks.callGateway.mockReset().mockResolvedValue({ status: "ok" });
    mocks.callGatewayTool.mockReset().mockResolvedValue({ key: "agent:main:dashboard:child" });
  });

  const subagentResume = {
    caller: { agentId: "main", sessionKey: "agent:main:main", assertCurrent: vi.fn() },
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
  const identity = {
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
        identity,
      ),
      read: readInProcessAgentRuntimeIdentity,
      binding: identity,
      carrierIndex: 2,
      error: "trusted agent runtime identity requires in-process Gateway dispatch",
    },
  ])(
    "keeps $name private and refuses transport fallback",
    async ({ request, read, binding, carrierIndex, error }) => {
      await callAgentToolGatewayRequest(request);
      expect(mocks.dispatch).toHaveBeenCalledWith(
        request.method,
        request.params,
        expect.anything(),
      );
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

  it("surfaces creation provenance only in-process and preserves the fallback timeout", async () => {
    await callInProcessGatewayToolWithCreation("sessions.create", { agentId: "main" }, creation);

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "sessions.create",
      { agentId: "main" },
      {
        forceSyntheticClient: true,
        operatorRoleActor: { kind: "system" },
        sessionCreation: creation,
        syntheticScopeMode: "minimum",
        syntheticScopes: ["operator.write"],
      },
    );
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();

    mocks.hasContext = false;
    await callInProcessGatewayToolWithCreation("sessions.create", { agentId: "main" }, creation, {
      timeoutMs: 120_000,
    });

    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "sessions.create",
      { timeoutMs: 120_000 },
      { agentId: "main" },
      { scopes: ["operator.write"] },
    );
  });

  it("uses an explicitly bound Gateway when worker creation has no ambient request scope", async () => {
    mocks.hasContext = false;
    const admitted = {} as GatewayRequestContext;
    const resolveGatewayContext = () => admitted;
    const sessionMutationCommitGuard = vi.fn();
    const workerCreation = {
      ...creation,
      requesterSessionKey: "agent:main:dashboard:worker",
      inheritedToolPolicy: { version: 1 as const, allow: ["sessions_spawn"], deny: [] },
    };

    await callInProcessGatewayToolWithCreation(
      "sessions.create",
      { agentId: "main" },
      workerCreation,
      {
        resolveGatewayContext,
        sessionMutationCommitGuard,
      },
    );

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "sessions.create",
      { agentId: "main" },
      expect.objectContaining({
        resolveGatewayContext: expect.any(Function),
        sessionMutationCommitGuard: expect.any(Function),
        sessionCreation: workerCreation,
      }),
    );
    const dispatchedOptions = mocks.dispatch.mock.calls[0]?.[2];
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
    const inheritedToolPolicy = {
      version: 1 as const,
      allow: ["read", "sessions_spawn"],
      deny: ["exec"],
    };
    const resolvedModel = { provider: "custom", model: "middle" };
    const spawnModelAutoSelection = { model: "custom/middle", hasFallbackOrigin: true };

    mocks.callGatewayTool.mockImplementationOnce(async () => {
      expect(getGatewaySessionSpawnContext()).toEqual({
        requesterSenderIsOwner: true,
        completionOwnerSessionKey: "agent:main:discord:direct:alice",
        inheritedToolPolicy,
        resolvedModel,
        spawnModelAutoSelection,
      });
      return { key: "agent:main:dashboard:child" };
    });

    await callInProcessGatewayToolWithCreation(
      "sessions.create",
      {
        agentId: "main",
        parentSessionKey: "agent:main:main",
        spawnDepth: 1,
        model: "custom/middle",
      },
      {
        via: "spawn",
        actor: { type: "agent", id: "main" },
        requesterSessionKey: "agent:main:main",
        requesterSenderIsOwner: true,
        completionOwnerSessionKey: "agent:main:discord:direct:alice",
        inheritedToolPolicy,
        resolvedModel,
        spawnModelAutoSelection,
      },
      { timeoutMs: 120_000 },
    );

    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "sessions.create",
      { timeoutMs: 120_000 },
      {
        agentId: "main",
        parentSessionKey: "agent:main:main",
        spawnDepth: 1,
        model: "custom/middle",
      },
      {
        scopes: ["operator.write"],
        requireAgentRuntimeIdentity: true,
      },
    );
    expect(getGatewaySessionSpawnContext()).toBeUndefined();
  });

  it("keeps session creation on the admitted Gateway through async settlement", async () => {
    const admitted = { gateway: "admitted" } as unknown as GatewayRequestContext;
    const replacement = { gateway: "replacement" } as unknown as GatewayRequestContext;
    const params = { agentId: "main", label: "worker" };
    const controller = new AbortController();
    let current = admitted;
    let admittedDispatches = 0;
    let replacementDispatches = 0;
    const dispatchThroughSelectedGateway = (
      options:
        | {
            resolveGatewayContext?: () => GatewayRequestContext | undefined;
          }
        | undefined,
    ) => {
      const selected = options?.resolveGatewayContext?.() ?? replacement;
      if (selected === admitted) {
        admittedDispatches += 1;
      } else if (selected === replacement) {
        replacementDispatches += 1;
      }
      return selected;
    };
    const runAsAdmittedCaller = async <T>(run: () => Promise<T>) =>
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          gatewayContextResolver: () => current,
        },
        run,
      );

    mocks.dispatch.mockImplementationOnce(async (_method, _params, options) => {
      expect(dispatchThroughSelectedGateway(options)).toBe(admitted);
      expect(options).toEqual({
        forceSyntheticClient: true,
        operatorRoleActor: { kind: "system" },
        resolveGatewayContext: expect.any(Function),
        sessionCreation: creation,
        signal: controller.signal,
        syntheticScopeMode: "minimum",
        syntheticScopes: ["operator.write"],
        timeoutMs: 2_000,
      });
      return { key: "agent:main:worker" };
    });

    await expect(
      runAsAdmittedCaller(() =>
        callInProcessGatewayToolWithCreation("sessions.create", params, creation, {
          signal: controller.signal,
          timeoutMs: 2_000,
        }),
      ),
    ).resolves.toEqual({ key: "agent:main:worker" });
    expect(mocks.dispatch).toHaveBeenLastCalledWith("sessions.create", params, expect.any(Object));
    expect({ admittedDispatches, replacementDispatches }).toEqual({
      admittedDispatches: 1,
      replacementDispatches: 0,
    });

    current = admitted;
    const dispatchesBeforeReplacement = mocks.dispatch.mock.calls.length;
    await expect(
      runAsAdmittedCaller(async () => {
        current = replacement;
        return await callInProcessGatewayToolWithCreation("sessions.create", params, creation);
      }),
    ).rejects.toThrow("Gateway instance unavailable for sessions.create");
    expect(mocks.dispatch).toHaveBeenCalledTimes(dispatchesBeforeReplacement);
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
    expect(replacementDispatches).toBe(0);

    for (const settlement of ["resolve", "reject"] as const) {
      current = admitted;
      const pendingDispatch = createDeferred<{ key: string }>();
      mocks.dispatch.mockImplementationOnce(async (_method, _params, options) => {
        expect(dispatchThroughSelectedGateway(options)).toBe(admitted);
        return await pendingDispatch.promise;
      });

      const expectedDispatchCount = mocks.dispatch.mock.calls.length + 1;
      const creationCall = runAsAdmittedCaller(() =>
        callInProcessGatewayToolWithCreation("sessions.create", params, creation),
      );
      await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(expectedDispatchCount));
      current = replacement;
      if (settlement === "resolve") {
        pendingDispatch.resolve({ key: "agent:main:worker" });
      } else {
        pendingDispatch.reject(new Error("inner dispatch failed"));
      }
      await expect(creationCall).rejects.toThrow(
        "Gateway instance unavailable for sessions.create",
      );
      expect(replacementDispatches).toBe(0);
    }
  });

  it("retains the generic helper's admitted binding and transport fallback", async () => {
    const admitted = { gateway: "admitted" } as unknown as GatewayRequestContext;
    const replacement = { gateway: "replacement" } as unknown as GatewayRequestContext;
    let current = admitted;
    mocks.dispatch.mockImplementationOnce(async (_method, _params, options) => ({
      selected: options?.resolveGatewayContext?.() ?? replacement,
    }));

    await expect(
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          gatewayContextResolver: () => current,
        },
        () => callInProcessGatewayTool("sessions.list", {}),
      ),
    ).resolves.toEqual({ selected: admitted });

    current = admitted;
    await expect(
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          gatewayContextResolver: () => current,
        },
        async () => {
          current = replacement;
          return await callInProcessGatewayTool("sessions.list", {});
        },
      ),
    ).rejects.toThrow("Gateway instance unavailable for sessions.list");

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

  it.each([
    {
      name: "request-shaped",
      call: () => callAgentToolGatewayRequest({ method: "sessions.list" }),
    },
    { name: "positional", call: () => callInProcessGatewayTool("sessions.list", {}) },
    {
      name: "trusted creation",
      call: () =>
        callInProcessGatewayToolWithCreation(
          "sessions.create",
          { agentId: "main" },
          {
            ...creation,
            inheritedToolPolicy: { version: 1, allow: ["read"], deny: [] },
          },
        ),
    },
  ])("refuses $name transport before forwarding admitted operator authority", async ({ call }) => {
    mocks.hasContext = false;
    await expect(
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          operatorAuthority: createAdmittedRunOperatorAuthority({
            profileId: "operator",
            scopes: ["operator.write"],
            assertCurrent: () => {},
          }),
        },
        call,
      ),
    ).rejects.toThrow("operator run authority requires its admitted Gateway");
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });
});

describe("request-shaped in-process Gateway dispatch", () => {
  beforeEach(() => {
    mocks.hasContext = true;
    mocks.dispatch.mockReset().mockResolvedValue({ runId: "run-1" });
    mocks.callGateway.mockReset().mockResolvedValue({ runId: "run-1" });
  });

  it.each([
    [undefined, 10_000],
    [null, undefined],
    [0, 0],
    [25_000, 25_000],
  ] as const)(
    "preserves request options and maps timeout %s to %s",
    async (timeoutMs, expected) => {
      const controller = new AbortController();
      const onAccepted = vi.fn();
      const agentToolCaller = {
        agentId: "main",
        sessionKey: "agent:main:discord:direct:colin",
      };

      await callAgentToolGatewayRequest({
        method: "agent",
        params: { sessionKey: "agent:main:worker", message: "run" },
        agentToolCaller,
        expectFinal: true,
        onAccepted,
        timeoutMs,
        signal: controller.signal,
      });

      expect(mocks.dispatch).toHaveBeenCalledWith(
        "agent",
        { sessionKey: "agent:main:worker", message: "run" },
        {
          forceSyntheticClient: true,
          operatorRoleActor: { kind: "system" },
          agentToolCaller,
          syntheticScopeMode: "minimum",
          syntheticScopes: ["operator.write"],
          expectFinal: true,
          onAccepted,
          signal: controller.signal,
          ...(expected === undefined ? {} : { timeoutMs: expected }),
          resolveGatewayContext: expect.any(Function),
        },
      );
      expect(mocks.callGateway).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "keeps abort cleanup on its admitted Gateway (replaced=%s)",
    async (replaced) => {
      const admitted = {} as GatewayRequestContext;
      let current = admitted;
      mocks.dispatch.mockImplementation(
        async (
          method: string,
          _params: unknown,
          options?: { onSignalAbort?: () => Promise<void> },
        ) => {
          if (method === "conversations.turn.cancel") {
            return { status: "ok" };
          }
          if (replaced) {
            current = {} as GatewayRequestContext;
          }
          await options?.onSignalAbort?.();
          throw new Error("primary aborted");
        },
      );
      await expect(
        withGatewayToolCallerIdentity(
          { agentId: "main", sessionKey: "agent:main:main", gatewayContextResolver: () => current },
          () =>
            callAgentToolGatewayRequest({
              method: "conversations.turn",
              params: { turnId: "turn-1" },
              onSignalAbort: async (request) => {
                await request("conversations.turn.cancel", { turnId: "turn-1" });
              },
            }),
        ),
      ).rejects.toThrow(replaced ? /Gateway|gateway|unavailable/u : "primary aborted");
      if (!replaced) {
        expect(mocks.dispatch.mock.calls).toContainEqual([
          "conversations.turn.cancel",
          { turnId: "turn-1" },
          expect.objectContaining({ forceSyntheticClient: true }),
        ]);
      }
      expect(
        mocks.dispatch.mock.calls.filter(([method]) => method === "conversations.turn.cancel"),
      ).toHaveLength(replaced ? 0 : 1);
      expect(mocks.callGateway).not.toHaveBeenCalled();
    },
  );

  it("keeps a captured multi-request operation on its original Gateway", async () => {
    const admitted = {} as GatewayRequestContext;
    let current: GatewayRequestContext | undefined = admitted;
    const request = bindAgentToolGatewayRequest({ resolveGatewayContext: () => current });
    await request({ method: "question.get", params: { id: "question-1" } });
    current = { ...admitted };
    await expect(
      request({ method: "question.resolve", params: { id: "question-1" } }),
    ).rejects.toThrow("Gateway instance unavailable");
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

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
          callAgentToolGatewayRequest({
            method: withCaller ? "agent" : "sessions.patch",
            params: withCaller
              ? { sessionKey: "agent:main:child", message: "Continue the child task" }
              : { key: "target", pinned: true },
            assertDispatchCurrent,
          });
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

    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "sessions.list",
      params: { limit: 5 },
      timeoutMs: 2_000,
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});

describe("built-in Gateway foreground authority", () => {
  beforeEach(() => {
    mocks.hasContext = true;
    mocks.dispatch.mockReset().mockResolvedValue({ ok: true });
    mocks.callGateway.mockReset();
    mocks.callGatewayTool.mockReset();
  });

  const callers = [
    {
      name: "request-shaped",
      call: () =>
        callAgentToolGatewayRequest({
          method: "sessions.patch",
          params: { key: "target", pinned: true },
        }),
    },
    {
      name: "generic",
      call: () => callInProcessGatewayTool("sessions.patch", { key: "target", pinned: true }),
    },
    {
      name: "Cron mutation",
      call: () => callAgentToolGatewayRequest({ method: "cron.add", params: {} }),
    },
  ];

  it.each(
    callers.flatMap((caller) =>
      ["dispatch", "commit"].map((boundary) => ({
        name: caller.name,
        call: caller.call,
        boundary,
      })),
    ),
  )("rejects retired $name caller authority before $boundary", async ({ call, boundary }) => {
    const entered = createDeferred();
    const release = createDeferred();
    let current = true;
    let committed = false;
    mocks.dispatch.mockImplementation(async (_method, _params, options) => {
      entered.resolve();
      await release.promise;
      options.sessionMutationCommitGuard?.();
      committed = true;
      return { ok: true };
    });
    const pending = withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:caller",
        operationalRunInstance: { instanceId: "caller-instance", runId: "caller-run" },
        receiptAuthority: () => current,
      },
      async () => {
        if (boundary === "dispatch") {
          current = false;
        }
        return await call();
      },
    );
    const rejected = expect(pending).rejects.toThrow(/authority.*no longer active/i);
    if (boundary === "commit") {
      await entered.promise;
      current = false;
      release.resolve();
    }
    await rejected;
    expect(committed).toBe(false);
    if (boundary === "dispatch") {
      expect(mocks.dispatch).not.toHaveBeenCalled();
    }
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("keeps a preserved write fenced by its original request signal", async () => {
    const controller = new AbortController();
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
    const pending = bindAgentToolGatewayRequest({ revalidateOnCompletion: false })({
      method: "message.action",
      params: { action: "channel-edit" },
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toThrow("message request canceled");
    try {
      await entered.promise;
      controller.abort(new Error("message request canceled"));
      release.resolve();
      await rejected;
      expect(commit).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  });

  it("lets host-owned abort cleanup settle without reopening the closed foreground caller", async () => {
    const context = {} as GatewayRequestContext;
    const controller = new AbortController();
    let current = true;
    let cancelled = false;
    mocks.dispatch.mockImplementation(async (method, _params, options) => {
      if (method === "conversations.turn.cancel") {
        expect(options.resolveGatewayContext()).toBe(context);
        expect(readInProcessAgentRuntimeIdentity(options)).toBeUndefined();
        cancelled = true;
        return { ok: true };
      }
      current = false;
      controller.abort();
      await options.onSignalAbort();
      throw new Error("primary aborted");
    });
    await expect(
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:caller",
          operationalRunInstance: { instanceId: "caller-instance", runId: "caller-run" },
          receiptAuthority: () => current,
          approvalSignals: [controller.signal],
          gatewayContextResolver: () => context,
        },
        () =>
          callAgentToolGatewayRequest({
            method: "conversations.turn",
            params: { turnId: "owned-turn" },
            signal: controller.signal,
            onSignalAbort: async (request) => {
              await request("conversations.turn.cancel", { turnId: "owned-turn" });
            },
          }),
      ),
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(mocks.dispatch.mock.calls.map(([method]) => method)).toEqual([
      "conversations.turn",
      "conversations.turn.cancel",
    ]);
  });
});
