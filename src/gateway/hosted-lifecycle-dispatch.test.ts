import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readLatestAssistantReply } from "../agents/run-wait.js";
import { subagentRegistryDeps } from "../agents/subagents/registry/subagent-registry-deps.js";
import { deleteSubagentSessionForCleanup } from "../agents/subagents/registry/subagent-session-cleanup.js";
import { resolveCommandSecretRefsViaGateway } from "../cli/command-secret-gateway.js";
import { deleteCronSessionViaGateway } from "../cron/isolated-agent/session-cleanup.js";
import { resolveQuestionOverGateway } from "../infra/question-gateway-resolver.js";
import { listSpawnedSessionKeysWithResult } from "../plugin-sdk/session-visibility-internal.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
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
import type { GatewayRequestContext, GatewayRequestHandlers } from "./server-methods/types.js";
import {
  getInProcessGatewayRequestContext,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";

const socketCall = vi.spyOn(gatewayCall, "callGateway");
afterAll(() => socketCall.mockRestore());

const questionId = "ask_0123456789abcdef0123456789abcdef";
const question = {
  id: questionId,
  status: "pending",
  questions: [{ questionId: "target", options: [{ label: "Staging" }] }],
};

const runtimes: ReturnType<typeof createGatewayInstanceRuntime>[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.close();
  }
});

function createContext(handlers: GatewayRequestHandlers): GatewayRequestContext {
  const registry = createGatewayMethodRegistry(
    Object.entries(handlers).map(([name, handler]) => {
      const scope = resolveLeastPrivilegeOperatorScopesForMethod(name)[0];
      if (!scope) {
        throw new Error(`Missing fixture scope for ${name}`);
      }
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
  context.recoveryRuntime = runtime.recovery;
  runtimes.push(runtime);
  return context;
}

describe("hosted lifecycle Gateway dispatch", () => {
  beforeEach(() => {
    socketCall.mockReset().mockRejectedValue(new Error("unexpected Gateway socket"));
  });

  it("reads cron/subagent history and session ownership without a transport", async () => {
    const context = createContext({
      "chat.history": ({ respond }) =>
        respond(true, { messages: [{ role: "assistant", content: "Child finished" }] }),
      "sessions.list": ({ params, respond }) => {
        expect(params.spawnedBy).toBe("agent:main:parent");
        respond(true, { sessions: [{ key: "agent:main:subagent:child" }] });
      },
    });
    await withPluginRuntimeGatewayContextResolver(
      () => context,
      async () => {
        await expect(readLatestAssistantReply({ sessionKey: "agent:main:child" })).resolves.toBe(
          "Child finished",
        );
        await expect(
          listSpawnedSessionKeysWithResult({ requesterSessionKey: "agent:main:parent" }),
        ).resolves.toEqual({ ok: true, value: new Set(["agent:main:subagent:child"]) });
      },
    );
    expect(socketCall).not.toHaveBeenCalled();
  });

  it("keeps cron and detached subagent cleanup on their Gateway with lifecycle preconditions", async () => {
    const deletions: unknown[] = [];
    let current: GatewayRequestContext | undefined = createContext({
      "sessions.delete": ({ params, respond }) => {
        deletions.push(params);
        respond(true, { deleted: true });
      },
    });
    const resolveGatewayContext = () => current;
    await withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
      expect(
        deleteCronSessionViaGateway({
          agentSessionKey: "agent:main:cron:job:run:one",
          sessionId: "cron-session",
          lifecycleRevision: "cron-revision",
        }),
      ).resolves.toBe(true),
    );
    const cleanup = () =>
      deleteSubagentSessionForCleanup({
        callGateway: subagentRegistryDeps.callGateway,
        gatewayBinding: { resolveGatewayContext },
        childSessionKey: "agent:main:subagent:child",
        expectedSessionId: "child-session",
        expectedLifecycleRevision: "child-revision",
      });
    await expect(cleanup()).resolves.toBe("deleted");
    expect(deletions).toMatchObject([
      { expectedSessionId: "cron-session", expectedLifecycleRevision: "cron-revision" },
      { expectedSessionId: "child-session", expectedLifecycleRevision: "child-revision" },
    ]);
    current = undefined;
    await expect(cleanup()).resolves.toBe("failed");
    expect(deletions).toHaveLength(2);
    expect(socketCall).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps omitted and explicitly unbound cleanup owners distinct: %s",
    async (unbound) => {
      const ambient = createContext({});
      const resolveAmbient = () => ambient;
      const callGateway = vi.fn(async () => {
        expect(getInProcessGatewayRequestContext()).toBe(unbound ? undefined : ambient);
        return {};
      });
      await withPluginRuntimeGatewayContextResolver(resolveAmbient, () =>
        expect(
          deleteSubagentSessionForCleanup({
            callGateway,
            ...(unbound ? { gatewayBinding: { resolveGatewayContext: undefined } } : {}),
            childSessionKey: "agent:main:subagent:child",
            expectedSessionId: "child-session",
            expectedLifecycleRevision: "child-revision",
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
    const context = createContext({
      "sessions.delete": async ({ sessionMutationCommitGuard, respond }) => {
        beforeCommit.resolve();
        await resumeCommit.promise;
        sessionMutationCommitGuard?.();
        mutate();
        respond(true, { deleted: true });
      },
    });
    let current = true;
    const cleanup = () =>
      deleteSubagentSessionForCleanup({
        callGateway: subagentRegistryDeps.callGateway,
        gatewayBinding: { resolveGatewayContext: () => context },
        childSessionKey: "agent:main:subagent:child",
        expectedSessionId: "child-session",
        expectedLifecycleRevision: "child-revision",
        isCurrent: () => current,
      });
    const invoke = await withOperatorToolGatewayAuthority(
      {
        authenticatedUserProfile: {
          profileId: "operator",
          displayName: null,
          hasAvatar: false,
          updatedAt: 1,
        },
        scopes: ["operator.write"],
      },
      async () => {
        const run = AsyncLocalStorage.snapshot();
        return () => run(cleanup);
      },
    );
    const result = invoke();
    await beforeCommit.promise;
    current = false;
    resumeCommit.resolve();
    await expect(result).resolves.toBe("failed");
    expect(mutate).not.toHaveBeenCalled();
    expect(socketCall).not.toHaveBeenCalled();
  });

  it("answers on the same Gateway and rejects replacement during source authorization", async () => {
    const answer = vi.fn();
    const context = createContext({
      "question.get": ({ respond }) => respond(true, { question }),
      "question.resolve": ({ params, respond }) => {
        answer(params);
        respond(true, { status: "answered" });
      },
    });
    let current = context;
    await withPluginRuntimeGatewayContextResolver(
      () => current,
      async () => {
        await expect(
          resolveQuestionOverGateway({
            cfg: {},
            questionId,
            optionIndex: 0,
            authorize: () => true,
          }),
        ).resolves.toMatchObject({ status: "answered", optionValue: "Staging" });
        await expect(
          resolveQuestionOverGateway({
            cfg: {},
            questionId,
            optionIndex: 0,
            authorize: async () => {
              current = createContext({});
              return true;
            },
          }),
        ).rejects.toThrow("Gateway instance unavailable");
      },
    );
    expect(answer).toHaveBeenCalledOnce();
    expect(socketCall).not.toHaveBeenCalled();
  });

  it("resolves hosted command SecretRefs from the active Gateway snapshot", async () => {
    const context = createContext({
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
    await withPluginRuntimeGatewayContextResolver(
      () => context,
      async () => {
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
      },
    );
    expect(socketCall).not.toHaveBeenCalled();
  });

  it("preserves an explicit remote question destination inside a hosted scope", async () => {
    socketCall.mockResolvedValueOnce({ question }).mockResolvedValueOnce({ status: "answered" });
    await withPluginRuntimeGatewayContextResolver(
      () => createContext({}),
      () =>
        expect(
          resolveQuestionOverGateway({
            cfg: {},
            questionId,
            optionIndex: 0,
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
