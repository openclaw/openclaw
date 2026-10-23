import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../agents/cli-runner.test-helpers.js";
import { createCliRunCurrentAssertion } from "../agents/cli-runner/execution-target.js";
import { prepareCliRunContext } from "../agents/cli-runner/prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "../agents/cli-runner/prepare.test-support.js";
import { claimPendingAgentQuestionAnswerFromCaller } from "../agents/harness/gateway-question.js";
import { withQuestionGateway } from "../agents/harness/gateway-question.test-support.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { ReplyToolAuthorityOverlay } from "../sessions/session-controller.contracts.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintAttachGrant,
  resolveMcpLoopbackClientGrant,
  revokeAttachGrant,
  transferMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { setMinimalCliPrepareDeps } from "./mcp-http.test-support.js";
import * as toolResolution from "./tool-resolution.js";

vi.mock("../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => null }));
vi.mock("../agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));
vi.mock("../tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: () => undefined,
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

const sessionKey = "agent:main:main";
const captureKey = "question-capture";
const questionArgs = {
  questions: [
    {
      id: "choice",
      header: "Choice",
      question: "Which destination should be used?",
      options: [{ label: "Staging" }, { label: "Production" }],
    },
  ],
};
const caller: ReplyToolAuthorityOverlay = {
  messageProvider: "webchat",
  senderIsOwner: true,
  toolsAllow: ["ask_user"],
  disableTools: false,
  traceAuthorized: false,
};
let fixtureSignal: AbortSignal;
const fixtureRuns = new Set<Promise<void>>();

type McpResponse = {
  result: {
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
};
type QuestionGateway = Parameters<Parameters<typeof withQuestionGateway>[0]>[0];
type CliQuestionFixture = ReturnType<typeof createQuestionFixture>["fixture"];

function resolveGrant(token: string, runtimeOwnerToken: string) {
  return resolveMcpLoopbackClientGrant({ token, runtimeOwnerToken, captureKey });
}

beforeEach(({ signal }) => {
  fixtureSignal = signal;
  // Shared channel stubs otherwise load bundled message adapters in this webchat-only fixture.
  setActivePluginRegistry(createEmptyPluginRegistry());
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [
      {
        ...buildDefaultTestCliBackend({ bundleMcp: true }),
        autoSelectAuthProfile: false,
        nativeToolMode: "selectable",
        toolAvailabilityEnforcement: "execution-args",
        resolveExecutionArgs: ({ baseArgs }) => baseArgs,
      },
    ],
  });
  setMinimalCliPrepareDeps(setCliRunnerPrepareTestDeps);
});

afterEach(async () => {
  // A timed-out fixture must finish before shared state belongs to the next test.
  await Promise.allSettled(fixtureRuns);
  resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
  vi.restoreAllMocks();
});

async function withCliQuestionLoopback(
  run: (fixture: CliQuestionFixture) => Promise<void>,
  signal = fixtureSignal,
) {
  signal.throwIfAborted();
  const cli = createCliRunnerPrepareFixture(prepareCliRunContext);
  const { dir } = cli.session;
  const fixtureRun = runQaGatewayFixture(
    async () =>
      await withQuestionGateway(async (gateway) => {
        const config: OpenClawConfig = {
          ...expectDefined(getRuntimeConfigSnapshot(), "isolated question gateway config"),
          agents: {
            defaults: { workspace: dir, model: "test-cli/test-model" },
            entries: { main: {} },
          },
          plugins: { enabled: false },
          tools: { profile: "full" },
        };
        // Config identity is stable: tools/list must seed the same cache used by tools/call.
        setRuntimeConfigSnapshot(config);
        await ensureMcpLoopbackServer();
        const { getActiveMcpLoopbackRuntime } = await import("./mcp-http.loopback-runtime.js");
        const runtime = expectDefined(getActiveMcpLoopbackRuntime(), "loopback runtime");
        const { fixture, cleanups } = createQuestionFixture(gateway, cli, config, runtime, signal);
        await runQaGatewayFixture(
          async () => {
            signal.throwIfAborted();
            await run(fixture);
          },
          ...cleanups,
        );
      }),
    () => closeOpenClawStateDatabaseForTest(),
    () => cli.cleanup(),
  );
  fixtureRuns.add(fixtureRun);
  void fixtureRun.finally(() => fixtureRuns.delete(fixtureRun)).catch(() => {});
  return fixtureRun;
}

function createQuestionFixture(
  gateway: QuestionGateway,
  cli: ReturnType<typeof createCliRunnerPrepareFixture>,
  config: OpenClawConfig,
  runtime: { port: number; ownerToken: string },
  signal: AbortSignal,
) {
  const operatorAuthority = createAdmittedRunOperatorAuthority({
    profileId: "question-owner",
    scopes: ["operator.admin"],
    gatewayAccessGrant: null,
    modelPolicy: prepareOperatorModelPolicy({ cfg: config, policy: {} }),
    assertCurrent: () => signal.throwIfAborted(),
  });
  const toolCalls: Promise<unknown>[] = [];
  const resolveTools = toolResolution.resolveGatewayScopedTools;
  const resolutions = vi
    .spyOn(toolResolution, "resolveGatewayScopedTools")
    .mockImplementation(async (...args) => {
      const scoped = await resolveTools(...args);
      for (const tool of scoped.tools) {
        const execute = tool.execute;
        vi.spyOn(tool, "execute").mockImplementation(async (...executeArgs) => {
          const pending = execute(...executeArgs);
          toolCalls.push(pending);
          return await pending;
        });
      }
      return scoped;
    });
  const requestController = new AbortController();
  const requestSignal = AbortSignal.any([signal, requestController.signal]);
  const contextCleanups: Array<() => unknown> = [];
  const admissionCleanups: Array<() => unknown> = [];
  const requests: Promise<McpResponse>[] = [];
  const persist = vi.fn(async () => {});
  const request = async (token: string, method: "tools/list" | "tools/call", attached = false) => {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
      method: "POST",
      signal: requestSignal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(attached ? {} : { "x-openclaw-cli-capture-key": captureKey }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        ...(method === "tools/call"
          ? { params: { name: "ask_user", arguments: questionArgs } }
          : {}),
      }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as McpResponse;
  };
  return {
    fixture: {
      prepare: async (
        runId = "mcp-question-run",
        target: { sessionKey?: string } = { sessionKey },
      ) => {
        signal.throwIfAborted();
        const source = new AbortController();
        const admission = prepareAgentRunAdmission({
          cfg: config,
          operatorAuthority,
          facts: {
            runId,
            agentId: "main",
            ingress: { kind: "system", boundary: "mcp-question-test", state: "present" },
          },
          operationalRunInstance: createOperationalRunInstanceRef(runId),
        });
        admissionCleanups.push(() => admission.close());
        const originalToolsAllow = ["ask_user"];
        const context = await cli.prepare({
          config,
          preparedRunAdmission: admission,
          sessionKey: target.sessionKey,
          runId,
          timeoutMs: 60_000,
          abortSignal: AbortSignal.any([signal, source.signal]),
          messageProvider: "webchat",
          operatorProfileId: operatorAuthority.profileId,
          requesterModel: { provider: "test-cli", model: "test-model" },
          senderIsOwner: true,
          toolsAllow: originalToolsAllow,
        });
        contextCleanups.push(() => context.preparedBackend.cleanup?.());
        signal.throwIfAborted();
        const token = expectDefined(
          context.preparedBackend.env?.OPENCLAW_MCP_TOKEN,
          "prepared CLI grant",
        );
        context.preparedBackend.mcpClientGrantCapture?.activate(
          captureKey,
          createCliRunCurrentAssertion(context.params),
        );
        expect(resolveGrant(token, runtime.ownerToken)?.isCurrent()).toBe(true);
        return { token, context, source, admission, originalToolsAllow };
      },
      list: (token: string, attached = false) => request(token, "tools/list", attached),
      ask: async (token: string, attached = false) => {
        const registration = gateway.holdRegistration();
        const response = request(token, "tools/call", attached);
        requests.push(response);
        void response.catch(() => {});
        try {
          await Promise.race([
            registration.entered,
            response.then((result) => {
              throw new Error("ask_user completed before question registration", {
                cause: result,
              });
            }),
          ]);
          expect(gateway.manager.list()).toHaveLength(1);
          const question = expectDefined(gateway.manager.list()[0], "registered ask_user question");
          return { id: question.id, response };
        } finally {
          registration.release();
        }
      },
      answer: (overlay = caller) =>
        claimPendingAgentQuestionAnswerFromCaller({
          sessionKey,
          text: "Staging",
          caller: { ...overlay, operatorAuthority },
          persist,
          assertSourceCurrent: () => {},
        }),
      retire: (id: string) => gateway.manager.cancel(id, "test-cleanup"),
      manager: gateway.manager,
      holdNextHello: gateway.holdNextHello,
      runtimeOwnerToken: runtime.ownerToken,
      resolutionCount: () => resolutions.mock.calls.length,
      resolveRequestCount: () =>
        gateway.requests.filter((frame) => frame.method === "question.resolve").length,
      persist,
    },
    cleanups: [
      () => {
        // Acquisition can fail before registration. Abort that transport first,
        // then join tool cancellation RPCs before the question Gateway is reset.
        requestController.abort();
        for (const question of gateway.manager.list()) {
          gateway.manager.cancel(question.id, "test-cleanup");
        }
      },
      () => Promise.allSettled(requests),
      () => closeMcpLoopbackServer(),
      () => Promise.allSettled(toolCalls),
      () => runQaGatewayFixture(async () => {}, ...contextCleanups, ...admissionCleanups),
      () => resolutions.mockRestore(),
    ],
  };
}

function expectAnswered({ result }: McpResponse) {
  expect(result).toMatchObject({
    isError: false,
    content: [{ type: "text", text: expect.stringContaining('"status": "answered"') }],
  });
}

function expectUnconsumed(fixture: CliQuestionFixture, id?: string) {
  expect(fixture.persist).not.toHaveBeenCalled();
  expect(fixture.resolveRequestCount()).toBe(0);
  if (id) {
    expect(fixture.manager.get(id)?.status).toBe("pending");
  }
}

it.each(["main", undefined])("binds cached creator authority for session %s", (targetKey) =>
  withCliQuestionLoopback(async (fixture) => {
    const owner = await fixture.prepare(undefined, { sessionKey: targetKey });
    if (targetKey === undefined) {
      expect(owner.context.params.sessionKey).toBeUndefined();
      const grant = expectDefined(
        resolveGrant(owner.token, fixture.runtimeOwnerToken),
        "CLI grant",
      );
      expect(grant.context.sessionKey).toBe(sessionKey);
      expect(grant.context).not.toHaveProperty("bindQuestionAnswerAuthority");
      const nativeAuthority = expectDefined(
        owner.context.bindQuestionAnswerAuthority,
        "binder",
      )(() => {});
      expect(nativeAuthority.sessionKey).toBe(owner.context.params.sessionId);
    }
    const beforeList = fixture.resolutionCount();
    expect((await fixture.list(owner.token)).result.tools?.map((tool) => tool.name)).toEqual([
      "ask_user",
    ]);
    await fixture.list(owner.token);
    expect(fixture.resolutionCount()).toBe(beforeList + 1);
    owner.originalToolsAllow.push("exec");
    const question = await fixture.ask(owner.token);
    expect(fixture.manager.get(question.id)?.sessionKey).toBe(sessionKey);
    expect(fixture.resolutionCount()).toBe(beforeList + 1);
    await expect(fixture.answer({ ...caller, toolsAllow: [] })).rejects.toThrow("caller policy");
    expect(fixture.persist).not.toHaveBeenCalled();
    expect(fixture.manager.get(question.id)?.status).toBe("pending");
    await expect(fixture.answer()).resolves.toBe(true);
    expect(fixture.persist).toHaveBeenCalledOnce();
    expect(fixture.resolveRequestCount()).toBe(1);
    expectAnswered(await question.response);
  }),
);

it("rejects aborted source authority without consuming the answer", () =>
  withCliQuestionLoopback(async (fixture) => {
    const owner = await fixture.prepare();
    const question = await fixture.ask(owner.token);
    await expect(fixture.answer({ ...caller, toolsAllow: [] })).rejects.toThrow("caller policy");
    owner.source.abort(new Error("original CLI source aborted"));
    expect(resolveGrant(owner.token, fixture.runtimeOwnerToken)).toBeUndefined();
    await expect(fixture.answer()).rejects.toThrow();
    expectUnconsumed(fixture, question.id);
    fixture.retire(question.id);
    await question.response;
  }));

it("transfers authority without reviving an old question", () =>
  withCliQuestionLoopback(async (fixture) => {
    const oldOwner = await fixture.prepare("same-correlated-run");
    await fixture.list(oldOwner.token);
    const old = await fixture.ask(oldOwner.token);
    await expect(fixture.answer({ ...caller, toolsAllow: [] })).rejects.toThrow("caller policy");
    const nextOwner = await fixture.prepare("same-correlated-run");
    expect(
      transferMcpLoopbackClientGrant({
        sourceToken: nextOwner.token,
        targetToken: oldOwner.token,
        runtimeOwnerToken: fixture.runtimeOwnerToken,
      }),
    ).toBe(true);
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: oldOwner.token,
        runtimeOwnerToken: fixture.runtimeOwnerToken,
        captureKey,
      }),
    ).toBeTruthy();
    await expect(fixture.answer()).rejects.toThrow();
    expect(fixture.persist).not.toHaveBeenCalled();
    fixture.retire(old.id);
    await old.response;
    oldOwner.admission.close();
    const beforeList = fixture.resolutionCount();
    await fixture.list(oldOwner.token);
    expect(fixture.resolutionCount()).toBe(beforeList + 1);
    const fresh = await fixture.ask(oldOwner.token);
    await expect(fixture.answer()).resolves.toBe(true);
    expectAnswered(await fresh.response);
  }));

it.for([
  { stage: "after", ending: "failure" },
  { stage: "before", ending: "cancellation" },
] as const)(
  "joins a question request on fixture $ending $stage registration",
  async ({ stage, ending }, { onTestFinished, signal }) => {
    const cancellation = new AbortController();
    const expectedError = new Error(`fixture stopped ${stage} question registration`);
    let requestSettled = false;
    let manager: QuestionGateway["manager"] | undefined;
    const run: Promise<void> = withCliQuestionLoopback(
      async (fixture) => {
        // Timed-out setup must not start a late request.
        signal.throwIfAborted();
        manager = fixture.manager;
        const grant = mintAttachGrant({ sessionKey });
        const hello = stage === "before" ? fixture.holdNextHello() : undefined;
        const asking = fixture.ask(grant.token, true);
        void asking.catch(() => {});
        onTestFinished(() =>
          runQaGatewayFixture(
            async () => hello?.release(),
            () => asking.catch(() => {}),
            () => {
              for (const question of fixture.manager.list()) {
                fixture.manager.cancel(question.id, "test-cleanup");
              }
            },
            () =>
              run.catch((error: unknown) => {
                if (error !== expectedError && !(signal.aborted && error === signal.reason)) {
                  throw error;
                }
              }),
          ),
        );
        try {
          const request = hello ? asking : (await asking).response;
          const markSettled = () => {
            requestSettled = true;
          };
          void request.then(markSettled, markSettled);
          if (hello) {
            await Promise.race([hello.entered, asking]);
          }
          expect(fixture.manager.list()).toHaveLength(stage === "before" ? 0 : 1);
          expect(requestSettled).toBe(false);
          if (ending === "cancellation") {
            cancellation.abort(expectedError);
            await request;
          } else {
            throw expectedError;
          }
        } finally {
          revokeAttachGrant(grant.token);
        }
      },
      AbortSignal.any([signal, cancellation.signal]),
    );
    // Keep hello held until the fixture has joined the aborted request.
    await expect(run).rejects.toBe(expectedError);
    expect(requestSettled).toBe(true);
    expect(manager?.list()).toEqual([]);
  },
);

it("resolves attach questions only through structured controls", () =>
  withCliQuestionLoopback(async (fixture) => {
    const grant = mintAttachGrant({ sessionKey });
    try {
      const question = await fixture.ask(grant.token, true);
      await expect(fixture.answer()).rejects.toThrow("no prepared creator authority");
      expectUnconsumed(fixture);
      const { callGatewayTool } = await import("../agents/tools/gateway.js");
      await callGatewayTool(
        "question.resolve",
        {},
        {
          id: question.id,
          answers: { answers: { choice: ["Staging"] } },
          resolvedBy: "structured-control",
        },
      );
      expectAnswered(await question.response);
    } finally {
      revokeAttachGrant(grant.token);
    }
  }));
