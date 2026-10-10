import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
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
import type { PreparedCliRunContext } from "../agents/cli-runner/types.js";
import { claimPendingAgentQuestionAnswerFromCaller } from "../agents/harness/gateway-question.js";
import { withQuestionGateway } from "../agents/harness/gateway-question.test-support.js";
import { resetPendingAskUserQuestionsForTest } from "../agents/tools/ask-user-tool.test-support.js";
import type { ReplyToolAuthorityOverlay } from "../auto-reply/reply/reply-run-registry.contracts.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintAttachGrant,
  resolveMcpLoopbackClientGrant,
  revokeAttachGrant,
  transferMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
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
  setCliRunnerPrepareTestDeps({
    isWorkspaceBootstrapPending: async () => false,
    makeBootstrapWarn: () => () => {},
    resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
    resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
    prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
    loadManifestModelCatalog: () => [],
  });
});

afterEach(async () => {
  // A timed-out fixture must finish before shared state belongs to the next test.
  await Promise.allSettled(fixtureRuns);
  resetPendingAskUserQuestionsForTest();
  resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
  vi.restoreAllMocks();
});

async function withCliQuestionLoopback(
  run: (fixture: {
    prepare: (
      runId?: string,
      target?: { sessionKey?: string },
    ) => Promise<{
      token: string;
      context: PreparedCliRunContext;
      source: AbortController;
      admission: PreparedAgentRunAdmission;
      originalToolsAllow: string[];
    }>;
    list: (token: string, attached?: boolean) => Promise<McpResponse>;
    ask: (
      token: string,
      attached?: boolean,
    ) => Promise<{
      id: string;
      response: Promise<McpResponse>;
    }>;
    answer: (overlay?: ReplyToolAuthorityOverlay) => Promise<boolean>;
    retire: (id: string) => void;
    manager: Parameters<Parameters<typeof withQuestionGateway>[0]>[0]["manager"];
    holdNextHello: Parameters<Parameters<typeof withQuestionGateway>[0]>[0]["holdNextHello"];
    runtimeOwnerToken: string;
    resolutionCount: () => number;
    resolveRequestCount: () => number;
    persist: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
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
          agents: { defaults: { workspace: dir }, entries: { main: {} } },
          plugins: { enabled: false },
          tools: { profile: "full" },
        };
        // Config identity is stable: tools/list must seed the same cache used by tools/call.
        setRuntimeConfigSnapshot(config);
        await ensureMcpLoopbackServer();
        const { getActiveMcpLoopbackRuntime } = await import("./mcp-http.loopback-runtime.js");
        const runtime = expectDefined(getActiveMcpLoopbackRuntime(), "loopback runtime");
        const toolCalls = new Set<Promise<unknown>>();
        const resolveTools = toolResolution.resolveGatewayScopedTools;
        const resolutions = vi
          .spyOn(toolResolution, "resolveGatewayScopedTools")
          .mockImplementation(async (...args) => {
            const scoped = await resolveTools(...args);
            for (const tool of scoped.tools) {
              const execute = tool.execute;
              vi.spyOn(tool, "execute").mockImplementation(async (...executeArgs) => {
                const pending = execute(...executeArgs);
                toolCalls.add(pending);
                try {
                  return await pending;
                } finally {
                  toolCalls.delete(pending);
                }
              });
            }
            return scoped;
          });
        const requestController = new AbortController();
        const requestSignal = AbortSignal.any([signal, requestController.signal]);
        const contexts: PreparedCliRunContext[] = [];
        const admissions: PreparedAgentRunAdmission[] = [];
        const requests: Promise<McpResponse>[] = [];
        const persist = vi.fn(async () => {});
        const request = async (
          token: string,
          method: "tools/list" | "tools/call",
          attached = false,
        ) => {
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
        await runQaGatewayFixture(
          async () => {
            signal.throwIfAborted();
            await run({
              prepare: async (runId = "mcp-question-run", target = { sessionKey }) => {
                signal.throwIfAborted();
                const source = new AbortController();
                const admission = prepareAgentRunAdmission({
                  cfg: config,
                  facts: {
                    runId,
                    agentId: "main",
                    ingress: { kind: "system", boundary: "mcp-question-test", state: "present" },
                  },
                  operationalRunInstance: createOperationalRunInstanceRef(runId),
                });
                admissions.push(admission);
                const originalToolsAllow = ["ask_user"];
                const context = await cli.prepare({
                  config,
                  preparedRunAdmission: admission,
                  sessionKey: target.sessionKey,
                  runId,
                  timeoutMs: 60_000,
                  abortSignal: AbortSignal.any([signal, source.signal]),
                  messageProvider: "webchat",
                  senderIsOwner: true,
                  toolsAllow: originalToolsAllow,
                });
                contexts.push(context);
                signal.throwIfAborted();
                const token = expectDefined(
                  context.preparedBackend.env?.OPENCLAW_MCP_TOKEN,
                  "prepared CLI grant",
                );
                context.preparedBackend.mcpClientGrantCapture?.activate(
                  captureKey,
                  createCliRunCurrentAssertion(context.params),
                );
                expect(
                  resolveMcpLoopbackClientGrant({
                    token,
                    runtimeOwnerToken: runtime.ownerToken,
                    captureKey,
                  })?.isCurrent(),
                ).toBe(true);
                return { token, context, source, admission, originalToolsAllow };
              },
              list: (token, attached) => request(token, "tools/list", attached),
              ask: async (token, attached) => {
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
                  const question = expectDefined(
                    gateway.manager.list()[0],
                    "registered ask_user question",
                  );
                  return { id: question.id, response };
                } finally {
                  registration.release();
                }
              },
              answer: (overlay = caller) =>
                claimPendingAgentQuestionAnswerFromCaller({
                  sessionKey,
                  text: "Staging",
                  caller: overlay,
                  persist,
                  assertSourceCurrent: () => {},
                }),
              retire: (id) => gateway.manager.cancel(id, "test-cleanup"),
              manager: gateway.manager,
              holdNextHello: gateway.holdNextHello,
              runtimeOwnerToken: runtime.ownerToken,
              resolutionCount: () => resolutions.mock.calls.length,
              resolveRequestCount: () =>
                gateway.requests.filter((frame) => frame.method === "question.resolve").length,
              persist,
            });
          },
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
          () =>
            runQaGatewayFixture(
              async () => {},
              ...contexts.map((context) => () => context.preparedBackend.cleanup?.()),
              ...admissions.map((admission) => () => admission.close()),
            ),
          () => resolutions.mockRestore(),
        );
      }),
    () => closeOpenClawStateDatabaseForTest(),
    () => cli.cleanup(),
  );
  fixtureRuns.add(fixtureRun);
  void fixtureRun.finally(() => fixtureRuns.delete(fixtureRun)).catch(() => {});
  return fixtureRun;
}

function expectAnswered(response: McpResponse) {
  expect(response.result.isError).toBe(false);
  expect(response.result.content).toEqual([
    expect.objectContaining({
      type: "text",
      text: expect.stringContaining('"status": "answered"'),
    }),
  ]);
}

describe("CLI loopback question creator authority", () => {
  it("answers a real cached ask_user with the CLI creator's original frozen policy", async () => {
    await withCliQuestionLoopback(async (fixture) => {
      const owner = await fixture.prepare(undefined, { sessionKey: "main" });
      const beforeList = fixture.resolutionCount();
      expect((await fixture.list(owner.token)).result.tools?.map((tool) => tool.name)).toEqual([
        "ask_user",
      ]);
      await fixture.list(owner.token);
      expect(fixture.resolutionCount()).toBe(beforeList + 1);
      owner.originalToolsAllow.push("exec");
      const question = await fixture.ask(owner.token);
      expect(fixture.resolutionCount()).toBe(beforeList + 1);

      await expect(fixture.answer({ ...caller, toolsAllow: [] })).rejects.toThrow("caller policy");
      expect(fixture.persist).not.toHaveBeenCalled();
      expect(fixture.manager.get(question.id)?.status).toBe("pending");
      await expect(fixture.answer()).resolves.toBe(true);
      expect(fixture.persist).toHaveBeenCalledOnce();
      expect(fixture.resolveRequestCount()).toBe(1);
      expectAnswered(await question.response);
    });
  });

  it("binds an omitted native session key to the actual MCP registration target", async () => {
    await withCliQuestionLoopback(async (fixture) => {
      const owner = await fixture.prepare(undefined, { sessionKey: undefined });
      expect(owner.context.params.sessionKey).toBeUndefined();
      const grant = expectDefined(
        resolveMcpLoopbackClientGrant({
          token: owner.token,
          runtimeOwnerToken: fixture.runtimeOwnerToken,
          captureKey,
        }),
        "live CLI grant",
      );
      expect(grant.context.sessionKey).toBe(sessionKey);
      expect(grant.context).not.toHaveProperty("bindQuestionAnswerAuthority");
      const nativeAuthority = expectDefined(
        owner.context.bindQuestionAnswerAuthority,
        "native question binder",
      )(() => {});
      expect(nativeAuthority.sessionKey).toBe(owner.context.params.sessionId);
      await fixture.list(owner.token);
      const question = await fixture.ask(owner.token);
      expect(fixture.manager.get(question.id)?.sessionKey).toBe(sessionKey);
      await expect(fixture.answer()).resolves.toBe(true);
      expectAnswered(await question.response);
    });
  });

  it("refuses a pending CLI question after source abort without consuming the answer", async () => {
    await withCliQuestionLoopback(async (fixture) => {
      const owner = await fixture.prepare();
      const question = await fixture.ask(owner.token);
      await expect(fixture.answer({ ...caller, toolsAllow: [] })).rejects.toThrow("caller policy");
      owner.source.abort(new Error("original CLI source aborted"));
      expect(
        resolveMcpLoopbackClientGrant({
          token: owner.token,
          runtimeOwnerToken: fixture.runtimeOwnerToken,
          captureKey,
        }),
      ).toBeUndefined();

      await expect(fixture.answer()).rejects.toThrow();
      expect(fixture.persist).not.toHaveBeenCalled();
      expect(fixture.resolveRequestCount()).toBe(0);
      expect(fixture.manager.get(question.id)?.status).toBe("pending");
      fixture.retire(question.id);
      await question.response;
    });
  });

  it("moves fresh creator authority onto a warm process token without reviving its old question", async () => {
    await withCliQuestionLoopback(async (fixture) => {
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
    });
  });

  it.for([
    { stage: "after", ending: "failure" },
    { stage: "before", ending: "cancellation" },
  ] as const)(
    "joins a question request on fixture $ending $stage registration",
    async ({ stage, ending }, { onTestFinished, signal }) => {
      const cancellation = new AbortController();
      const expectedError = new Error(`fixture stopped ${stage} question registration`);
      let releaseHello = () => {};
      let asking: Promise<{ id: string; response: Promise<McpResponse> }> | undefined;
      let requestSettled = false;
      let manager: Parameters<Parameters<typeof withQuestionGateway>[0]>[0]["manager"] | undefined;
      const run = withCliQuestionLoopback(
        async (fixture) => {
          // Timed-out setup must not start a late request.
          signal.throwIfAborted();
          manager = fixture.manager;
          const grant = mintAttachGrant({ sessionKey });
          const hello = stage === "before" ? fixture.holdNextHello() : undefined;
          if (hello) {
            releaseHello = hello.release;
          }
          try {
            asking = fixture.ask(grant.token, true);
            void asking.catch(() => {});
            const request = hello ? asking : (await asking).response;
            void request.then(
              () => {
                requestSettled = true;
              },
              () => {
                requestSettled = true;
              },
            );
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
      onTestFinished(() =>
        runQaGatewayFixture(
          async () => {
            // Also unblock recovery if Vitest times out a regressed join.
            releaseHello();
          },
          () => asking?.catch(() => {}),
          () => {
            for (const question of manager?.list() ?? []) {
              manager?.cancel(question.id, "test-cleanup");
            }
          },
          () =>
            run.catch((error: unknown) => {
              if (error === expectedError || (signal.aborted && error === signal.reason)) {
                return;
              }
              throw error;
            }),
        ),
      );
      // Keep hello held until the fixture has joined the aborted request.
      await expect(run).rejects.toBe(expectedError);
      expect(requestSettled).toBe(true);
      expect(manager?.list()).toEqual([]);
    },
  );

  it("keeps attach questions answerable through structured controls without inventing a caller snapshot", async () => {
    await withCliQuestionLoopback(async (fixture) => {
      const grant = mintAttachGrant({ sessionKey });
      try {
        const question = await fixture.ask(grant.token, true);
        await expect(fixture.answer()).rejects.toThrow("no prepared creator authority");
        expect(fixture.persist).not.toHaveBeenCalled();
        expect(fixture.resolveRequestCount()).toBe(0);
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
    });
  });
});
