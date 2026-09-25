import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { mergeAcceptedSessionSpawnsForRun } from "../accepted-session-spawn.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { readParentExecutionIdentity } from "../subagents/spawn/execution-identity-spawn-context.js";
import {
  captureTestSpawnToolPolicy,
  expectRegisteredSubagentRun,
} from "../subagents/spawn/subagent-spawn.test-helpers.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import type { createSessionsSpawnTool as SpawnToolFactory } from "./sessions-spawn-tool.js";

type SessionsSpawnCompletionFixture = {
  createTool: typeof SpawnToolFactory;
  registerAcpBackendForTest: () => void;
  mocks: {
    spawnSubagentDirectMock: Mock;
    spawnAcpDirectMock: Mock;
    inProcessCreationMock: Mock;
    registerSubagentRunMock: Mock;
  };
  mockCallArg: (
    mock: unknown,
    callIndex: number,
    argIndex: number,
    label: string,
  ) => Record<string, unknown>;
};

/** Completion receipts share the parent suite's tool graph and reset lifecycle. */
export function registerSessionsSpawnCompletionTests({
  createTool: createSessionsSpawnTool,
  registerAcpBackendForTest,
  mocks: hoisted,
  mockCallArg,
}: SessionsSpawnCompletionFixture) {
  it.each([
    { name: "default", input: {}, expected: true },
    { name: "announcing", input: { expectsCompletionMessage: true }, expected: true },
    { name: "quiet", input: { expectsCompletionMessage: false }, expected: false },
  ])(
    "declares completion policy and forwards $name to hidden, ACP, and visible spawns",
    async ({ input, expected }) => {
      registerAcpBackendForTest();
      await withTestDir({ prefix: "openclaw-spawn-completion-" }, async (dir) => {
        const callGateway = vi.fn(async () => ({
          key: "agent:main:dashboard:child",
          runStarted: true,
          runId: "run-visible",
        }));
        const registerRun = vi.fn();
        const options = {
          agentSessionKey: "agent:main:main",
          config: { session: { store: path.join(dir, "sessions.json") } },
          callGateway: callGateway as never,
          registerRun,
          countActiveRuns: () => 0,
        };
        const tool = createSessionsSpawnTool({
          ...options,
          captureInheritedToolPolicyForDelegation: captureTestSpawnToolPolicy,
        });
        const acpTool = createSessionsSpawnTool(options);
        expect(tool.parameters).toMatchObject({
          properties: { expectsCompletionMessage: { type: "boolean" } },
        });

        await tool.execute("hidden", { task: "hidden child", ...input });
        expect(
          mockCallArg(hoisted.spawnSubagentDirectMock, 0, 0, "spawnSubagentDirect")
            .expectsCompletionMessage,
        ).toBe(expected);
        expect(
          mockCallArg(hoisted.spawnSubagentDirectMock, 0, 0, "spawnSubagentDirect")
            .completionTarget,
        ).toBeUndefined();

        await acpTool.execute("acp", {
          task: "ACP child",
          runtime: "acp",
          ...input,
        });
        expect(
          mockCallArg(hoisted.spawnAcpDirectMock, 0, 0, "spawnAcpDirect").expectsCompletionMessage,
        ).toBe(expected);
        expect(
          mockCallArg(hoisted.spawnAcpDirectMock, 0, 0, "spawnAcpDirect").completionTarget,
        ).toBeUndefined();

        const visible = await tool.execute("visible", {
          task: "visible child",
          visible: true,
          ...input,
        });
        expect(visible.details).toMatchObject({ expectsCompletionMessage: expected });
        expectRegisteredSubagentRun(registerRun, { expectsCompletionMessage: expected });
        expect(mockCallArg(registerRun, 0, 0, "registerRun").completionTarget).toBeUndefined();
      });
    },
  );

  it("retains committed child acceptance when the caller loses its result", async () => {
    hoisted.spawnSubagentDirectMock.mockResolvedValueOnce({
      status: "accepted",
      context: "isolated",
      childSessionKey: "agent:main:subagent:child",
      runId: "child-run",
      expectsCompletionMessage: true,
    });
    const instance = createOperationalRunInstanceRef("spawn-parent");
    await expect(
      withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: "agent:main:main", operationalRunInstance: instance },
        async () => {
          const tool = createSessionsSpawnTool({
            agentSessionKey: "agent:main:main",
            captureInheritedToolPolicyForDelegation: captureTestSpawnToolPolicy,
          });
          await tool.execute("spawn-before-failure", { task: "finish the work" });
          throw new Error("provider transport failed after acceptance");
        },
      ),
    ).rejects.toThrow("provider transport failed");
    expect(mergeAcceptedSessionSpawnsForRun(instance)).toEqual([
      {
        runId: "child-run",
        childSessionKey: "agent:main:subagent:child",
        expectsCompletionMessage: true,
      },
    ]);
    expect(
      mergeAcceptedSessionSpawnsForRun(createOperationalRunInstanceRef("spawn-parent")),
    ).toEqual([]);
  });
}

export function registerSessionsSpawnPrivateRouteTests({
  createTool: createSessionsSpawnTool,
  registerAcpBackendForTest,
  mocks: hoisted,
}: SessionsSpawnCompletionFixture) {
  it("advertises the private completion contract and passes it to native spawn", async () => {
    const tool = createSessionsSpawnTool({
      captureInheritedToolPolicyForDelegation: captureTestSpawnToolPolicy,
    });
    const schema = tool.parameters as {
      required?: string[];
      properties: Record<string, { description?: string; enum?: string[] }>;
    };
    const target = schema.properties.completionTarget;
    if (!target) {
      throw new Error("expected completionTarget schema property");
    }
    expect(target.enum).toEqual(["parent"]);
    expect(schema.required ?? []).not.toContain("completionTarget");
    expect(target).not.toHaveProperty("default");
    for (const restriction of [
      "ACP",
      "collect",
      "visible",
      "thread",
      "session mode",
      "expectsCompletionMessage=false",
    ]) {
      expect(target.description).toContain(restriction);
    }
    await tool.execute("private-spawn", { task: "review privately", completionTarget: "parent" });
    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({ completionTarget: "parent" }),
      expect.anything(),
    );
  });

  it.each([{ runtime: "acp" }, { visible: true }, { completionTarget: "channel" }])(
    "rejects unsupported private tool routes before dispatch: %j",
    async (options) => {
      registerAcpBackendForTest();
      const tool = createSessionsSpawnTool();
      await expect(
        tool.execute("private-spawn", {
          task: "review privately",
          completionTarget: "parent",
          ...options,
        }),
      ).rejects.toThrow(/completionTarget/);
      expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
      expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
      expect(hoisted.inProcessCreationMock).not.toHaveBeenCalled();
    },
  );
}

export function registerSessionsSpawnParentLineageTests({
  createTool: createSessionsSpawnTool,
  registerAcpBackendForTest,
  mocks: hoisted,
  mockCallArg,
}: SessionsSpawnCompletionFixture) {
  it.each([
    { runtime: "subagent" as const, spawn: hoisted.spawnSubagentDirectMock },
    { runtime: "acp" as const, spawn: hoisted.spawnAcpDirectMock },
  ])(
    "forwards the exact private parent token to the $runtime spawn owner",
    async ({ runtime, spawn }) => {
      if (runtime === "acp") {
        registerAcpBackendForTest();
      }
      const parentToken = createExecutionIdentityAdmissionToken("parent-run", {
        contextId: "parent-context",
        executionId: "parent-execution",
        now: 100,
      });
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        ...(runtime === "subagent"
          ? { captureInheritedToolPolicyForDelegation: captureTestSpawnToolPolicy }
          : {}),
      });

      const result = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          ...(runtime === "subagent"
            ? { operationalRunInstance: createOperationalRunInstanceRef("parent-run") }
            : {}),
          executionIdentityToken: parentToken,
        },
        async () =>
          await tool.execute(`spawn-${runtime}`, {
            task: "inspect child lineage",
            runtime,
            ...(runtime === "acp" ? { agentId: "codex" } : {}),
          }),
      );

      const context = mockCallArg(spawn, 0, 1, `${runtime} spawn`);
      expect(readParentExecutionIdentity(context)).toBe(parentToken);
      expect(JSON.stringify(tool.parameters)).not.toContain("parentExecutionIdentityToken");
      expect(JSON.stringify(result.details)).not.toContain("parent-context");
      expect(JSON.stringify(result.details)).not.toContain("parent-execution");
    },
  );
}

export function registerSessionsSpawnRequesterRouteTests({
  createTool: createSessionsSpawnTool,
  registerAcpBackendForTest,
  mocks: hoisted,
  mockCallArg,
}: SessionsSpawnCompletionFixture) {
  it("registers requesterSessionKey from the provided agentSessionKey, not the sandbox peer key", async () => {
    const tool = createSessionsSpawnTool({
      captureInheritedToolPolicyForDelegation: captureTestSpawnToolPolicy,
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
      agentAccountId: "bot-1",
      agentTo: "telegram:direct:123",
    });

    await tool.execute("call-requester-key", {
      task: "background research",
    });

    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    const spawnContext = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 1, "spawnSubagentDirect");
    expect(spawnContext.agentSessionKey).toBe("agent:main:main");
  });

  it("does not use the Telegram peer key as requesterSessionKey when agentSessionKey is the run session", async () => {
    const telegramPeerKey = "agent:main:telegram:default:direct:456";
    const runSessionKey = "agent:main:main";

    const toolWithPeerKey = createSessionsSpawnTool({
      captureInheritedToolPolicyForDelegation: captureTestSpawnToolPolicy,
      agentSessionKey: telegramPeerKey,
      agentChannel: "telegram",
      agentAccountId: "default",
      agentTo: "telegram:direct:456",
    });

    await toolWithPeerKey.execute("call-peer-key", { task: "task A" });

    const toolWithRunKey = createSessionsSpawnTool({
      captureInheritedToolPolicyForDelegation: captureTestSpawnToolPolicy,
      agentSessionKey: runSessionKey,
      agentChannel: "telegram",
      agentAccountId: "default",
      agentTo: "telegram:direct:456",
    });

    await toolWithRunKey.execute("call-run-key", { task: "task B" });

    const peerContext = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 1, "spawnSubagentDirect");
    const runContext = mockCallArg(hoisted.spawnSubagentDirectMock, 1, 1, "spawnSubagentDirect");
    expect(peerContext.agentSessionKey).toBe(telegramPeerKey);
    expect(runContext.agentSessionKey).toBe(runSessionKey);
  });

  it("passes completion ownership and active thinking separately from agentSessionKey", async () => {
    const tool = createSessionsSpawnTool({
      captureInheritedToolPolicyForDelegation: captureTestSpawnToolPolicy,
      agentSessionKey: "agent:main:telegram:default:direct:456",
      completionOwnerKey: "agent:main:main",
      agentChannel: "telegram",
      agentAccountId: "default",
      agentTo: "telegram:direct:456",
      requesterThinkingLevel: "ultra",
    });

    await tool.execute("call-completion-owner", { task: "background work" });

    const spawnContext = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 1, "spawnSubagentDirect");
    expect(spawnContext.agentSessionKey).toBe("agent:main:telegram:default:direct:456");
    expect(spawnContext.completionOwnerKey).toBe("agent:main:main");
    expect(spawnContext.requesterThinkingLevel).toBe("ultra");
  });

  it("forwards completionOwnerKey to the ACP registration pipeline", async () => {
    registerAcpBackendForTest();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:telegram:default:direct:456",
      completionOwnerKey: "agent:main:main",
      agentChannel: "telegram",
      agentAccountId: "default",
      agentTo: "telegram:direct:456",
    });

    await tool.execute("call-acp-completion-owner", {
      runtime: "acp",
      task: "investigate",
      agentId: "codex",
    });

    const spawnContext = mockCallArg(hoisted.spawnAcpDirectMock, 0, 1, "spawnAcpDirect");
    expect(spawnContext.agentSessionKey).toBe("agent:main:telegram:default:direct:456");
    expect(spawnContext.completionOwnerKey).toBe("agent:main:main");
  });
}

export function registerSessionsSpawnInlineAcpCompletionTest({
  createTool: createSessionsSpawnTool,
  registerAcpBackendForTest,
  mocks: hoisted,
  mockCallArg,
}: SessionsSpawnCompletionFixture) {
  it("forwards completion policy for inline ACP session delivery", async () => {
    registerAcpBackendForTest();
    hoisted.spawnAcpDirectMock.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: "agent:codex:acp:1",
      runId: "run-acp",
      mode: "session",
      inlineDelivery: true,
    });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
      agentAccountId: "default",
      agentTo: "channel:parent-channel",
      agentThreadId: "child-thread",
    });

    await tool.execute("call-inline-acp", {
      runtime: "acp",
      task: "investigate",
      agentId: "codex",
      thread: true,
      mode: "session",
    });

    const spawnArgs = mockCallArg(hoisted.spawnAcpDirectMock, 0, 0, "spawnAcpDirect");
    expect(spawnArgs.mode).toBe("session");
    expect(spawnArgs.cleanup).toBe("keep");
    expect(spawnArgs.expectsCompletionMessage).toBe(true);
    // Inline-delivery suppression is decided after the ACP adapter binds its thread.
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });
}
