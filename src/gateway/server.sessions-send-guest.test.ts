import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import type { AgentCommandGatewayIngressOpts as IngressCommand } from "../agents/command/types.js";
import * as preparedRuntime from "../agents/prepared-model-runtime.js";
import { createSessionsSendTool } from "../agents/tools/sessions-send-tool.js";
import { withPersonalToolTurn } from "../auto-reply/reply/personal-tool-turn.test-support.js";
import { writeConfigFile } from "../config/io.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import * as pendingInputs from "../config/sessions/session-accessor.pending-inputs.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
} from "./test-helpers.js";

const MESSAGE = "Continue the retained review.";

let harness: GatewayServerHarness;
let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    const cfg = rolePolicyConfig();
    const role = expectDefined(cfg.gateway?.roles?.definitions?.view, "guest role");
    role.scopes = ["operator.sessions.read", "operator.sessions.write"];
    role.sandbox = "required";
    cfg.tools = { sessions: { visibility: "all" } };
    await writeConfigFile(cfg);
    const module = await import("./server-kernel.js");
    const create = module.createGatewayKernel;
    const capture = vi.spyOn(module, "createGatewayKernel").mockImplementation(async (...args) => {
      kernel = await create(...args);
      return kernel;
    });
    try {
      harness = await startGatewayServerHarness();
    } finally {
      capture.mockRestore();
    }
  },
  cleanup: async () => harness?.close(),
});

async function withFollowup(
  run: (fixture: {
    send: (sessionKey?: string) => Promise<unknown>;
    revoke: () => void;
    profileId: string;
    child: string;
    foreign: string;
    runId: string;
    readInput: (sessionKey?: string) => Promise<{ pending: unknown; transcript: unknown }>;
    waitForCompletion: (signal: AbortSignal) => Promise<void>;
  }) => Promise<void>,
) {
  const context = kernel.gatewayRequestContext;
  const cfg = context.getRuntimeConfig();
  const role = expectDefined(cfg.gateway?.roles?.definitions?.view, "guest role");
  await prepareGatewayReplyRuntimeForTest({ force: true, config: cfg });
  agentCommandMock.mockReset();
  const runId = randomUUID();
  const parent = `agent:main:dashboard:followup-parent-${runId}`;
  const child = `agent:main:dashboard:followup-child-${runId}`;
  const foreign = `agent:main:dashboard:followup-foreign-${runId}`;
  const client = roleClient("view", `followup-owner-${runId}`);
  client.connect.scopes = [...role.scopes];
  const profileId = expectDefined(client.authenticatedUserProfile, "original person").profileId;
  for (const [sessionKey, creatorId] of [
    [parent, profileId],
    [child, profileId],
    [foreign, "another-person"],
  ] as const) {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: sessionKey,
        lifecycleRevision: "retained-generation",
        updatedAt: 1,
        visibility: "shared",
        status: "done",
        createdVia: "operator",
        createdActor: { type: "human", source: "profile", id: creatorId },
        sandbox: "required",
        ...(sessionKey === child ? { spawnedBy: parent, parentSessionId: parent } : {}),
      },
    );
  }
  const readInput = async (sessionKey = child) => {
    const scope = {
      agentId: "main",
      sessionKey,
      sessionId: sessionKey,
      storePath: (await loadSessionEntryAsync(sessionKey, { agentId: "main" })).storePath,
    };
    return {
      pending: await pendingInputs.listSessionPendingInputs(scope),
      transcript: await loadTranscriptEvents(scope),
    };
  };
  const source = new AbortController();
  const captured = expectDefined(
    await captureGatewayOperatorRunAuthority({
      client,
      context,
      sourceAuthority: {
        signal: source.signal,
        assertCurrent: () => source.signal.throwIfAborted(),
      },
    }),
    "guest authority",
  );
  const executionModule = await import("./agent-turn/agent-run-execution-phase.js");
  const execute = executionModule.startAgentRunExecution;
  const completed = createDeferred();
  const executions: Promise<void>[] = [];
  const execution = vi
    .spyOn(executionModule, "startAgentRunExecution")
    .mockImplementation((params) => {
      const pending = execute(params);
      executions.push(pending);
      if (params.runId === runId) {
        completed.resolve(pending);
      }
      return pending;
    });
  try {
    await withPluginRuntimeGatewayRequestScope(
      { client, context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
      () =>
        withPersonalToolTurn(
          {
            owner: {
              profileId,
              senderId: "followup-owner",
              name: "Followup owner",
              operatorAuthority: captured.authority,
            },
            sessionKey: parent,
            sessionId: parent,
          },
          async () => {
            const tool = createSessionsSendTool({
              config: cfg,
              agentSessionKey: parent,
              completionOwner: "caller",
              idempotencyKey: runId,
            });
            await run({
              send: (sessionKey = child) =>
                tool.execute("followup-child", {
                  sessionKey,
                  mode: "followup",
                  message: MESSAGE,
                  timeoutSeconds: 0,
                }),
              revoke: () => source.abort(new Error("followup source revoked")),
              profileId,
              child,
              foreign,
              runId,
              readInput,
              waitForCompletion: (signal) => withinTest(completed.promise, signal),
            });
          },
        ),
    );
  } finally {
    await Promise.allSettled(executions);
    execution.mockRestore();
    captured.release();
  }
}

it("persists narrow followups but denies raw agent calls", async ({ signal }) => {
  await withFollowup(async ({ send, profileId, child, runId, readInput, waitForCompletion }) => {
    agentCommandMock.mockImplementation(async (input) => {
      const command = input as IngressCommand;
      await expectDefined(
        command.userTurnTranscriptRecorder,
        "real input recorder",
      ).persistApproved();
      return { payloads: [], meta: { durationMs: 1 } };
    });
    await expect(send()).resolves.toMatchObject({ details: { status: "accepted", runId } });
    await waitForCompletion(signal);
    const command = agentCommandMock.mock.calls[0]?.[0] as IngressCommand;
    expect(command).toMatchObject({ sessionKey: child, sessionId: child });
    expect(command.operatorAuthority).toMatchObject({
      profileId,
      scopes: expect.arrayContaining(["operator.sessions.write"]),
      rolePolicy: { sandboxRequired: true },
    });
    expect(command.operatorAuthority?.scopes).not.toContain("operator.write");
    const accepted = await readInput();
    expect(JSON.stringify(accepted.transcript)).toContain(MESSAGE);
    await expect(
      dispatchGatewayMethodInProcess("agent", {
        sessionKey: child,
        expectedExistingSessionId: child,
        expectedExistingSessionLifecycleRevision: "retained-generation",
        message: "Unbound input",
        idempotencyKey: "unbound-run",
      }),
    ).rejects.toThrow("missing scope: operator.write");
    expect(await readInput()).toEqual(accepted);
    expect(agentCommandMock).toHaveBeenCalledOnce();
  });
});

it("rejects an unrelated target without persisting or executing input", async () => {
  await withFollowup(async ({ send, foreign, readInput }) => {
    const before = await readInput(foreign);
    await expect(send(foreign)).resolves.toMatchObject({ details: { status: "forbidden" } });
    expect(await readInput(foreign)).toEqual(before);
    expect(agentCommandMock).not.toHaveBeenCalled();
  });
});

it("rejects preparation-time revocation without input effects", async ({ signal }) => {
  await withFollowup(async ({ send, revoke, readInput }) => {
    const before = await readInput();
    const entered = createDeferred();
    const release = createDeferred();
    const load = preparedRuntime.loadPublishedGatewayReplyDispatchRuntime;
    const held = vi
      .spyOn(preparedRuntime, "loadPublishedGatewayReplyDispatchRuntime")
      .mockImplementationOnce(async (params) => {
        const runtime = await load(params);
        entered.resolve();
        await release.promise;
        return runtime;
      });
    const stage = vi.spyOn(pendingInputs, "stageSessionPendingInput");
    const sending = send();
    const settled = sending.catch(() => undefined);
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          entered.promise,
          settled,
          "Followup ended before real runtime preparation",
        ),
        signal,
      );
      revoke();
      release.resolve();
      await expect(sending).rejects.toThrow("followup source revoked");
      expect(stage).not.toHaveBeenCalled();
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(await readInput()).toEqual(before);
    } finally {
      release.resolve();
      await settled;
      held.mockRestore();
      stage.mockRestore();
    }
  });
});
