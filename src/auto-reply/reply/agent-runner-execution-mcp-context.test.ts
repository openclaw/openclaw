import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { SessionMcpRuntime } from "../../agents/agent-bundle-mcp-types.js";
import { buildCurrentInboundPrompt } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import {
  getMcpAppModelContext,
  updateMcpAppModelContext,
} from "../../agents/mcp-app-model-context.js";
import { fetchMcpAppView, getMcpAppViewLease } from "../../agents/mcp-ui-resource.js";
import { testing as viewTesting } from "../../agents/mcp-ui-resource.test-support.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  initialFallbackAttemptOptions,
  setupAgentRunnerExecutionTestState,
  type EmbeddedAgentParams,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();
beforeEach(() => viewTesting.clearViewStore());
afterEach(() => viewTesting.clearViewStore());
const image = {
  type: "image" as const,
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz0AAAAASUVORK5CYII=",
};
async function prepareView(runtime: SessionMcpRuntime, requesterId?: string, agentId = "main") {
  Object.assign(runtime, {
    sessionKey: "main",
    mcpAppsEnabled: true,
    readResource: async () => ({
      contents: [
        { uri: "ui://demo/app", mimeType: "text/html;profile=mcp-app", text: "<p>app</p>" },
      ],
    }),
  });
  const descriptor = await fetchMcpAppView({
    runtime,
    agentId,
    serverName: "native",
    toolName: "show",
    uiResourceUri: "ui://demo/app",
    toolInput: {},
    toolResult: { content: [] },
    allowedAppToolNames: new Set(),
    requesterId,
  });
  return getMcpAppViewLease(descriptor!.viewId, runtime)!;
}
const { executeAgentTurn } = await import("./agent-runner-execution.js");

describe("executeAgentTurn MCP App context", () => {
  it.each([
    { profileId: "alice", senderId: "discord:12345", attached: true },
    { profileId: "bob", senderId: "alice", attached: false },
    { profileId: undefined, senderId: "alice", attached: false },
  ])(
    "uses the admitted profile $profileId rather than transport sender $senderId",
    async ({ profileId, senderId, attached }) => {
      const runtime = { sessionId: "session" } as SessionMcpRuntime;
      const view = await prepareView(runtime, "alice");
      updateMcpAppModelContext(runtime, view, {
        content: [{ type: "text", text: "mapped private selection" }, image],
      });
      const params = createMinimalRunAgentTurnParams();
      params.followupRun.run.senderId = senderId;
      params.followupRun.operatorAuthority = profileId
        ? createAdmittedRunOperatorAuthority({
            profileId,
            scopes: ["operator.read", "operator.write"],
            assertCurrent() {},
          })
        : undefined;
      await executeAgentTurn(params);
      const input = state.runEmbeddedAgentMock.mock.calls[0]?.[0];
      expect(input?.images ?? []).toEqual(attached ? [image] : []);
      expect(
        JSON.stringify(input?.currentInboundContext ?? {}).includes("mapped private selection"),
      ).toBe(attached);
    },
  );
  it("keeps another agent's App context isolated when bare keys and session ids coincide", async () => {
    const runtime = { sessionId: "session" } as SessionMcpRuntime;
    const view = await prepareView(runtime, "alice", "research");
    updateMcpAppModelContext(runtime, view, {
      content: [{ type: "text", text: "foreign project selection" }, image],
    });
    const params = createMinimalRunAgentTurnParams();
    params.followupRun.operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "alice",
      scopes: ["operator.read", "operator.write"],
      assertCurrent() {},
    });
    expect(params.followupRun.run.agentId).toBe("main");
    await executeAgentTurn(params);
    const input = state.runEmbeddedAgentMock.mock.calls[0]?.[0];
    expect(input?.images ?? []).toEqual([]);
    expect(JSON.stringify(input?.currentInboundContext ?? {})).not.toContain(
      "foreign project selection",
    );
    expect(getMcpAppModelContext(runtime, view)).not.toBeNull();
  });

  it("never attaches another requester’s App context", async () => {
    const runtime = { sessionId: "session" } as SessionMcpRuntime;
    const view = await prepareView(runtime, "bob");
    updateMcpAppModelContext(runtime, view, {
      content: [{ type: "text", text: "private selection" }, image],
    });
    const params = createMinimalRunAgentTurnParams();
    params.followupRun.run.senderId = "alice";
    await executeAgentTurn(params);
    expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.images ?? []).toEqual([]);
    expect(
      JSON.stringify(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.currentInboundContext ?? {}),
    ).not.toContain("private selection");
    expect(getMcpAppModelContext(runtime, view)).not.toBeNull();
  });
  it.each(["model_call_started", "turn_accepted"] as const)(
    "injects context and native images exactly once at %s without rewriting transcript text",
    async (phase) => {
      const runtime = { sessionId: "session" } as SessionMcpRuntime;
      const view = await prepareView(runtime);
      updateMcpAppModelContext(runtime, view, {
        content: [
          { type: "text", text: "selected item 42", _meta: { "openai/title": "Selection" } },
          image,
        ],
      });
      state.runEmbeddedAgentMock.mockImplementation(async (params: EmbeddedAgentParams) => {
        params.onExecutionPhase?.({ phase });
        return { payloads: [{ text: "ok" }], meta: {} };
      });

      await executeAgentTurn({
        ...createMinimalRunAgentTurnParams(),
        commandBody: "show details",
        transcriptCommandBody: "show details",
      });
      await executeAgentTurn({
        ...createMinimalRunAgentTurnParams(),
        commandBody: "next question",
        transcriptCommandBody: "next question",
      });

      expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.images).toEqual([image]);
      expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.imageOrder).toEqual(["inline"]);
      expect(
        JSON.stringify(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.currentInboundContext),
      ).not.toContain(image.data);
      expect(
        JSON.stringify(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.currentInboundContext),
      ).not.toContain("_meta");
      expect(state.peekSessionMcpRuntimeMock).not.toHaveBeenCalled();
      expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.prompt).toBe("show details");
      expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.currentInboundContext).toMatchObject({
        text: expect.stringContaining("selected item 42"),
        fragments: expect.arrayContaining([
          { kind: "conversation-data", text: expect.stringContaining("selected item 42") },
        ]),
      });
      expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.transcriptPrompt).toBe("show details");
      expect(state.runEmbeddedAgentMock.mock.calls[1]?.[0]?.prompt).toBe("next question");
      expect(state.runEmbeddedAgentMock.mock.calls[1]?.[0]?.transcriptPrompt).toBe("next question");
      expect(
        JSON.stringify(state.runEmbeddedAgentMock.mock.calls[1]?.[0]?.currentInboundContext ?? {}),
      ).not.toContain("selected item 42");
    },
  );

  it("indexes App images after existing user images at the actual next-turn boundary", async () => {
    const runtime = { sessionId: "session" } as SessionMcpRuntime;
    const first = await prepareView(runtime);
    const second = await prepareView(runtime);
    updateMcpAppModelContext(runtime, first, { content: [image] });
    updateMcpAppModelContext(runtime, second, {
      content: [
        {
          type: "resource",
          resource: { uri: "parts://image", mimeType: image.mimeType, blob: image.data },
        },
      ],
    });
    state.resolveCurrentTurnImagesMock.mockResolvedValueOnce({
      images: [image],
      imageOrder: ["inline"],
    });
    await executeAgentTurn(createMinimalRunAgentTurnParams());
    const input = state.runEmbeddedAgentMock.mock.calls[0]?.[0];
    expect(input?.images).toEqual([image, image, image]);
    expect(input?.imageOrder).toEqual(["inline", "inline", "inline"]);
    expect(input?.currentInboundContext?.text).toContain('"imageIndex":1');
    expect(input?.currentInboundContext?.text).toContain('"imageIndex":2');
    expect(input?.currentInboundContext?.text).not.toContain('"imageIndex":0');
  });

  it("does not consume pending MCP App context when pre-start validation fails", async () => {
    const runtime = { sessionId: "session" } as SessionMcpRuntime;
    const view = await prepareView(runtime);
    updateMcpAppModelContext(runtime, view, {
      content: [{ type: "text", text: "still pending" }],
    });
    state.resolveCurrentTurnImagesMock.mockRejectedValueOnce(new Error("invalid image"));

    await expect(executeAgentTurn(createMinimalRunAgentTurnParams())).rejects.toThrow(
      "invalid image",
    );
    expect(getMcpAppModelContext(runtime, view)?.content).toEqual([
      { type: "text", text: "still pending" },
    ]);
    state.resolveCurrentTurnImagesMock.mockResolvedValueOnce({});
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onExecutionPhase?.({ phase: "model_call_started" });
      return { payloads: [{ text: "ok" }], meta: {} };
    });
    await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.currentInboundContext).toMatchObject({
      text: expect.stringContaining("still pending"),
      fragments: expect.arrayContaining([
        { kind: "conversation-data", text: expect.stringContaining("still pending") },
      ]),
    });
    expect(getMcpAppModelContext(runtime, view)).toBeNull();
  });

  it("retains pending MCP App context in full and resumable CLI prompts until process start", async () => {
    const followupRun = createFollowupRun();
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";
    const { provider, model } = followupRun.run;
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run(provider, model, initialFallbackAttemptOptions(params)),
      provider,
      model,
      attempts: [],
    }));
    const runtime = { sessionId: "session" } as SessionMcpRuntime;
    const view = await prepareView(runtime);
    updateMcpAppModelContext(runtime, view, {
      content: [{ type: "text", text: "CLI selection" }],
    });
    state.runCliAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onExecutionPhase?.({ phase: "process_spawned" });
      return { payloads: [{ text: "final" }], meta: {} };
    });
    followupRun.currentInboundContext = {
      text: "Room backlog",
      resumableText: "Current room event",
    };

    await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
      }),
    );

    const cliParams = state.runCliAgentMock.mock.calls[0]?.[0];
    expect(cliParams?.prompt).toBe("fix it");
    expect(cliParams?.transcriptPrompt ?? cliParams?.prompt).toBe("fix it");
    expect(cliParams?.currentInboundContext?.text).toContain("CLI selection");
    const resumedPrompt = buildCurrentInboundPrompt({
      context: cliParams?.currentInboundContext,
      prompt: cliParams?.prompt ?? "",
      preferResumableText: true,
    });
    expect(resumedPrompt).toContain("CLI selection");
    expect(resumedPrompt).toContain("Current room event");
    expect(resumedPrompt).not.toContain("Room backlog");
    expect(followupRun.currentInboundContext.resumableText).toBe("Current room event");
    expect(getMcpAppModelContext(runtime, view)).toBeNull();
  });
});
