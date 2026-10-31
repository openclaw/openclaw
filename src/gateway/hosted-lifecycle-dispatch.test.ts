import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { readLatestAssistantReply } from "../agents/run-wait.js";
import { deleteSubagentSessionForCleanup } from "../agents/subagents/registry/subagent-session-cleanup.js";
import { resolveCommandSecretRefsViaGateway } from "../cli/command-secret-gateway.js";
import { deleteCronSessionViaGateway } from "../cron/isolated-agent/session-cleanup.js";
import { resolveQuestionOverGateway } from "../infra/question-gateway-resolver.js";
import { listSpawnedSessionKeysWithResult } from "../plugin-sdk/session-visibility-internal.js";
import { createOwnedInstance } from "../plugins/plugin-instance.test-support.js";
import { PluginInvocationScope } from "../plugins/plugin-invocation-scope.js";
import { withPluginRuntimeGatewayContextResolver as withinGateway } from "../plugins/runtime/gateway-request-scope.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  buildTalkTestProviderConfig,
  readTalkTestProviderApiKey,
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS,
} from "../test-utils/talk-test-provider.js";
import * as gatewayCall from "./call.js";
import { resolveLeastPrivilegeOperatorScopesForMethod } from "./method-scopes.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import { bindGatewayLifecycleRequest } from "./server-lifecycle-runtime-context.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./server-methods/types.js";
import {
  getInProcessGatewayRequestContext,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";
import { gatewayProfile } from "./server/client-fixtures.test-support.js";

const deleteGatewaySession = vi.hoisted(() =>
  vi.fn<typeof import("./server-methods/sessions-delete.js").deleteGatewaySession>(),
);
vi.mock("./server-methods/sessions-delete.js", () => ({ deleteGatewaySession }));

const socketCall = vi.spyOn(gatewayCall, "callGateway");
afterAll(() => socketCall.mockRestore());

const questionId = "ask_0123456789abcdef0123456789abcdef";
const question = {
  id: questionId,
  status: "pending",
  questions: [{ questionId: "target", options: [{ label: "Staging" }] }],
};
const questionRequest = { cfg: {}, questionId, optionIndex: 0 };
const childSession = {
  childSessionKey: "agent:main:subagent:child",
  expectedSessionId: "child-session",
  expectedLifecycleRevision: "child-revision",
};

const runtimes: ReturnType<typeof createGatewayInstanceRuntime>[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.close();
  }
});

function createGateway(handlers: GatewayRequestHandlers) {
  const registry = createGatewayMethodRegistry(
    Object.entries(handlers).map(([name, handler]) => {
      const scope = resolveLeastPrivilegeOperatorScopesForMethod(name)[0];
      assert(scope, `Missing fixture scope for ${name}`);
      return { name, handler, owner: { kind: "core" as const, area: "test" }, scope };
    }),
  );
  const context = {
    trackExecution: trackAsyncWork,
    deps: {},
    getRuntimeConfig: () => ({}),
    getGatewayMethodRegistry: () => registry,
    logGateway: { warn: vi.fn(), error: vi.fn() },
  } as unknown as GatewayRequestContext;
  const runtime = createGatewayInstanceRuntime({
    getContext: () => context,
    getMethodRegistry: () => registry,
    isDispatchAvailable: () => true,
  });
  context.lifecycleRuntime = runtime.lifecycle;
  runtimes.push(runtime);
  return () => context;
}

function cleanupChild(
  resolveGatewayContext: () => GatewayRequestContext | undefined,
  isCurrent?: () => boolean,
) {
  return deleteSubagentSessionForCleanup({
    callGateway: (request) => bindGatewayLifecycleRequest()(request),
    gatewayBinding: { resolveGatewayContext },
    ...childSession,
    isCurrent,
  });
}

describe("hosted lifecycle Gateway dispatch", () => {
  beforeEach(() => {
    socketCall.mockReset().mockRejectedValue(new Error("unexpected Gateway socket"));
    deleteGatewaySession.mockReset().mockRejectedValue(new Error("unexpected session deletion"));
  });

  it("reads cron/subagent history and session ownership without a transport", async () => {
    const resolveContext = createGateway({
      "chat.history": ({ respond }) =>
        respond(true, { messages: [{ role: "assistant", content: "Child finished" }] }),
      "sessions.list": ({ params, respond }) => {
        expect(params.spawnedBy).toBe("agent:main:parent");
        respond(true, { sessions: [{ key: "agent:main:subagent:child" }] });
      },
    });
    await withinGateway(resolveContext, async () => {
      await expect(readLatestAssistantReply({ sessionKey: "agent:main:child" })).resolves.toBe(
        "Child finished",
      );
      await expect(
        listSpawnedSessionKeysWithResult({ requesterSessionKey: "agent:main:parent" }),
      ).resolves.toEqual({ ok: true, value: new Set(["agent:main:subagent:child"]) });
    });
    expect(socketCall).not.toHaveBeenCalled();
  });

  it("keeps cron and detached subagent cleanup on their Gateway with lifecycle preconditions", async () => {
    const deletions: unknown[] = [];
    let current: GatewayRequestContext | undefined = createGateway({
      "sessions.delete": ({ params, respond }) => {
        deletions.push(params);
        respond(true, { deleted: true });
      },
    })();
    const resolveGatewayContext = () => current;
    await withinGateway(resolveGatewayContext, () =>
      expect(
        deleteCronSessionViaGateway({
          agentSessionKey: "agent:main:cron:job:run:one",
          sessionId: "cron-session",
          lifecycleRevision: "cron-revision",
        }),
      ).resolves.toBe(true),
    );
    await expect(cleanupChild(resolveGatewayContext)).resolves.toBe("deleted");
    expect(deletions).toMatchObject([
      { expectedSessionId: "cron-session", expectedLifecycleRevision: "cron-revision" },
      { expectedSessionId: "child-session", expectedLifecycleRevision: "child-revision" },
    ]);
    current = undefined;
    await expect(cleanupChild(resolveGatewayContext)).resolves.toBe("failed");
    expect(deletions).toHaveLength(2);
    expect(socketCall).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps omitted and explicitly unbound cleanup owners distinct: %s",
    async (unbound) => {
      const resolveAmbient = createGateway({});
      const ambient = resolveAmbient();
      const callGateway = vi.fn(async () => {
        expect(getInProcessGatewayRequestContext()).toBe(unbound ? undefined : ambient);
        return {};
      });
      await withinGateway(resolveAmbient, () =>
        expect(
          deleteSubagentSessionForCleanup({
            callGateway,
            ...(unbound ? { gatewayBinding: { resolveGatewayContext: undefined } } : {}),
            ...childSession,
          }),
        ).resolves.toBe("deleted"),
      );
      expect(callGateway).toHaveBeenCalledOnce();
      expect(socketCall).not.toHaveBeenCalled();
    },
  );

  it("keeps transferred cleanup independent of expired tool authority and checks its owner before commit", async () => {
    const beforeCommit = createDeferredCore();
    const resumeCommit = createDeferredCore();
    const mutate = vi.fn();
    const resolveContext = createGateway({});
    deleteGatewaySession.mockImplementation(async ({ params, assertCurrent }) => {
      beforeCommit.resolve();
      await resumeCommit.promise;
      assertCurrent?.();
      mutate();
      return { ok: true, result: { ok: true, key: params.key, deleted: true, archived: [] } };
    });
    let current = true;
    const cleanup = () => cleanupChild(resolveContext, () => current);
    const invoke = await withOperatorToolGatewayAuthority(
      {
        authenticatedUserProfile: gatewayProfile("operator"),
        scopes: ["operator.write"],
      },
      async () => AsyncLocalStorage.snapshot(),
    );
    const result = invoke(cleanup);
    try {
      await awaitGateBeforeSettlement(
        beforeCommit.promise,
        result,
        "Transferred cleanup settled before reaching the session deletion owner",
      );
      current = false;
    } finally {
      resumeCommit.resolve();
    }
    await expect(result).resolves.toBe("failed");
    expect(mutate).not.toHaveBeenCalled();
    expect(socketCall).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "re-admits transferred plugin cleanup after its caller closes with owner current=%s",
    async (ownerStaysCurrent) => {
      const { instance, registry } = createOwnedInstance("cleanup-owner");
      const invocation = new PluginInvocationScope(registry, [instance], { retained: true });
      const effect = vi.fn();
      const cleanupPlugin = instance.wrap(effect);
      const staleCleanup = invocation.wrap(cleanupPlugin);
      const invoke = invocation.run(() => AsyncLocalStorage.snapshot());
      invocation.release();
      const beforeCommit = createDeferredCore();
      const resumeCommit = createDeferredCore();
      const resolveContext = createGateway({});
      let current = true;
      deleteGatewaySession.mockImplementation(async ({ params, assertCurrent }) => {
        beforeCommit.resolve();
        await resumeCommit.promise;
        assertCurrent?.();
        cleanupPlugin();
        return { ok: true, result: { ok: true, key: params.key, deleted: true, archived: [] } };
      });
      const result = invoke(() => cleanupChild(resolveContext, () => current));
      try {
        expect(() => staleCleanup()).toThrow("Plugin cleanup-owner consumer is closed");
        await awaitGateBeforeSettlement(
          beforeCommit.promise,
          result,
          "Transferred cleanup never reached its captured Gateway",
        );
        current = ownerStaysCurrent;
        resumeCommit.resolve();
        await expect(result).resolves.toBe(ownerStaysCurrent ? "deleted" : "failed");
        expect(effect).toHaveBeenCalledTimes(ownerStaysCurrent ? 1 : 0);
        expect(() => staleCleanup()).toThrow("Plugin cleanup-owner consumer is closed");
        expect(socketCall).not.toHaveBeenCalled();
      } finally {
        resumeCommit.resolve();
        invocation.release();
        await Promise.allSettled([result]);
        await instance.dispose();
      }
    },
  );

  it("answers on the same Gateway and rejects replacement during source authorization", async () => {
    const answer = vi.fn();
    let current = createGateway({
      "question.get": ({ respond }) => respond(true, { question }),
      "question.resolve": ({ params, respond }) => {
        answer(params);
        respond(true, { status: "answered" });
      },
    })();
    const resolveContext = () => current;
    await withinGateway(resolveContext, async () => {
      await expect(
        resolveQuestionOverGateway({ ...questionRequest, authorize: () => true }),
      ).resolves.toMatchObject({ status: "answered", optionValue: "Staging" });
      await expect(
        resolveQuestionOverGateway({
          ...questionRequest,
          authorize: async () => {
            current = createGateway({})();
            return true;
          },
        }),
      ).rejects.toThrow("Gateway instance unavailable");
    });
    expect(answer).toHaveBeenCalledOnce();
    expect(socketCall).not.toHaveBeenCalled();
  });

  it("resolves hosted command SecretRefs from the active Gateway snapshot", async () => {
    const resolveContext = createGateway({
      "secrets.resolve": ({ params, respond }) => {
        expect(params.targetIds).toEqual(["talk.providers.*.apiKey"]);
        respond(true, {
          assignments: [
            {
              path: TALK_TEST_PROVIDER_API_KEY_PATH,
              pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
              value: "synthetic-hosted-value",
            },
          ],
          diagnostics: [],
        });
      },
    });
    await withinGateway(resolveContext, async () => {
      const result = await resolveCommandSecretRefsViaGateway({
        config: buildTalkTestProviderConfig({
          source: "env",
          provider: "default",
          id: "SYNTHETIC_HOSTED_KEY",
        }),
        commandName: "message",
        targetIds: new Set(["talk.providers.*.apiKey"]),
      });
      expect(readTalkTestProviderApiKey(result.resolvedConfig)).toBe("synthetic-hosted-value");
      expect(result.targetStatesByPath[TALK_TEST_PROVIDER_API_KEY_PATH]).toBe("resolved_gateway");
    });
    expect(socketCall).not.toHaveBeenCalled();
  });

  it("preserves an explicit remote question destination inside a hosted scope", async () => {
    socketCall.mockResolvedValueOnce({ question }).mockResolvedValueOnce({ status: "answered" });
    await withinGateway(createGateway({}), () =>
      expect(
        resolveQuestionOverGateway({
          ...questionRequest,
          gatewayUrl: "wss://gateway.example.test",
        }),
      ).resolves.toMatchObject({ status: "answered" }),
    );
    expect(socketCall).toHaveBeenCalledTimes(2);
    expect(socketCall).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: "wss://gateway.example.test", method: "question.resolve" }),
    );
  });
});
