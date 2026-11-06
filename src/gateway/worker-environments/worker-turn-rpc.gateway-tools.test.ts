import assert from "node:assert/strict";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { bindAgentToolExecutionLocation } from "../../agents/agent-tool-metadata.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../../agents/harness/tool-surface-bridge.js";
import { createToolSurfacePresentationForTest } from "../../agents/tool-surface-plan.test-support.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { getWorkerTurnToolSurface } from "./placement-turn-claim-events.js";
import * as support from "./service.test-support.js";
import { createWorkerGatewayToolRuntime } from "./worker-gateway-tool-runtime.js";

const toolSuccess = { ok: true, result: { details: { ok: true } } };
const toolError = { ok: true, result: { details: { status: "error" } } };
const toolResult = { content: [], details: { ok: true } };
const schema = ({
  name,
  description,
  parameters,
}: Pick<AnyAgentTool, "name" | "description" | "parameters">) => ({
  name,
  description,
  parameters,
});

async function toolHarness(name: string, codeMode = false) {
  const fixture = await support.placementHarness(`worker-${name}`, `session-${name}`);
  const execute = vi.fn<AnyAgentTool["execute"]>(async () => toolResult);
  const tool: AnyAgentTool = {
    name: "portal",
    label: "Portal",
    description: "Open a portal",
    parameters: Type.Object(
      { action: Type.Literal("open"), port: Type.Optional(Type.Integer()) },
      { additionalProperties: false },
    ),
    execute: async (...args) => {
      fixture.source.receiptAuthority();
      const result = await execute(...args);
      fixture.source.receiptAuthority();
      return result;
    },
  };
  bindAgentToolExecutionLocation(tool, { kind: "gateway" });
  const runtime = createWorkerGatewayToolRuntime({
    assertCurrent: () => {
      if (getWorkerTurnToolSurface(fixture.identity) !== runtime) {
        throw new Error("Tool surface owner changed");
      }
    },
    signal: new AbortController().signal,
    prepare: async () => ({
      tools: [tool],
      presentation: createToolSurfacePresentationForTest({
        tools: { codeMode, toolSearch: false },
      }),
      policy: {
        workspaceOnly: true,
        readOnly: false,
        applyPatchEnabled: false,
        applyPatchWorkspaceOnly: true,
        imageSanitization: {},
      },
    }),
  });
  fixture.bindToolSurface(runtime);
  const surface = await fixture.workerService.getToolSurface(fixture.identity);
  assert(surface.ok, "Expected an admitted tool surface");
  const request = {
    generation: surface.result.generation,
    toolId: surface.result.tools[0]!.id,
    toolCallId: "call",
    arguments: { action: "open", port: 3000 },
  };
  const invoke = (input = request) =>
    fixture.workerService.invokeGatewayTool(fixture.identity, input, { send: vi.fn() });
  const cancel = () =>
    fixture.workerService.cancelGatewayTool(fixture.identity, {
      generation: request.generation,
      toolCallId: request.toolCallId,
    });
  return { ...fixture, execute, request, invoke, cancel, surface: surface.result };
}

function bindHeartbeat(
  h: Awaited<ReturnType<typeof support.placementHarness>>,
  refresh: Parameters<typeof h.bindGitHubGrant>[0]["refresh"],
  revoke = vi.fn(async () => {}),
) {
  h.bindGitHubGrant({
    binding: { token: "synthetic-initial", login: "fixture", branch: "fixture" },
    signal: new AbortController().signal,
    assertCurrent() {},
    refresh,
    revoke,
  });
  return revoke;
}

support.setupWorkerEnvironmentServiceSuite();

it("admits the worker's code-mode schemas while rejecting raw or altered schemas", async () => {
  const h = await toolHarness("model-presentation", true);
  const worker = createAgentHarnessToolSurfaceRuntimeCore({
    presentation: h.surface.presentation,
    modelToolsEnabled: true,
    supportsDeferredToolCalls: false,
  });
  try {
    const projected = worker
      .compactTools(
        h.surface.tools.map(({ definition }) => ({ ...definition, execute: h.execute })),
        { prepared: { preserveToolNames: [] } },
      )
      .tools.map(schema);
    expect(projected.map((tool) => tool.name)).toEqual(["exec", "wait"]);
    const request = support.inferenceRequest(h.identity);
    const infer = (
      tools: typeof projected,
      connectionId: string,
      send: Parameters<typeof h.workerService.startInference>[2]["send"] = vi.fn(),
    ) =>
      h.workerService.startInference(
        h.identity,
        { ...request, context: { ...request.context, tools } },
        { connectionId, send },
      );
    for (const tools of [
      h.surface.tools.map(({ definition }) => schema(definition)),
      projected.map((tool) => ({ ...tool, description: "unadmitted description" })),
    ]) {
      await expect(infer(tools, "schema-mismatch")).resolves.toEqual({
        ok: false,
        reason: "invalid-context",
      });
    }
    const finished = createDeferred();
    const started = await infer(
      projected,
      "projected-tools",
      vi.fn(() => finished.resolve()),
    );
    assert(started.ok, "Projected worker tools were not admitted");
    await h.workerService.cancelInference(h.identity, request);
    started.launch();
    await finished.promise;
    expect(h.execute).not.toHaveBeenCalled();
    await expect(h.invoke()).resolves.toMatchObject(toolSuccess);
  } finally {
    worker.cleanup();
  }
});

it("accepts only issued handles and canonical arguments before dispatch", async () => {
  const h = await toolHarness("tool-authority");
  for (const request of [
    { ...h.request, generation: "old-generation" },
    { ...h.request, toolId: "unissued" },
    { ...h.request, arguments: { action: "delete", port: 3000 } },
  ]) {
    await expect(h.invoke(request)).resolves.toMatchObject(toolError);
  }
  expect(h.execute).not.toHaveBeenCalled();
  await expect(h.invoke()).resolves.toMatchObject(toolSuccess);
  expect(h.execute).toHaveBeenCalledOnce();
  h.placementStore.validateWorkerTurn.mockReturnValue(false);
  await expect(h.invoke()).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
  expect(h.execute).toHaveBeenCalledOnce();
});

it("cancels an issued invocation before its first yield without starting the tool", async () => {
  const h = await toolHarness("cancel-before-yield");
  const [invoked, cancelled] = await Promise.all([h.invoke(), h.cancel()]);
  expect(cancelled).toEqual({ ok: true, result: { cancelled: true } });
  expect(invoked).toMatchObject({
    ok: true,
    result: { details: { status: "error", error: "Worker tool call cancelled" } },
  });
  expect(h.execute).not.toHaveBeenCalled();
});

it.each(["placement", "run"] as const)(
  "fences success and failure after awaited %s revocation",
  async (authority) => {
    for (const fails of [false, true]) {
      const h = await toolHarness(`tool-revoked-${authority}-${fails}`);
      h.execute.mockImplementationOnce(async () => {
        await Promise.resolve();
        if (authority === "placement") {
          h.placementStore.validateWorkerTurn.mockReturnValue(false);
        } else {
          h.releaseSource();
        }
        if (fails) {
          throw new Error("Tool failed after authority changed");
        }
        return toolResult;
      });
      await expect(h.invoke()).resolves.toMatchObject({ ok: false });
      await expect(h.workerService.getToolSurface(h.identity)).resolves.toMatchObject({
        ok: false,
      });
      await expect(h.cancel()).resolves.toMatchObject({ ok: false });
    }
  },
);
it("fences a credential prepared before its retained caller closes", async () => {
  const h = await support.placementHarness("github-refresh", "github-refresh-session");
  const entered = createDeferred();
  const release = createDeferred();
  const revoke = bindHeartbeat(h, async () => {
    entered.resolve();
    await release.promise;
    return { generation: 1, token: "synthetic-replacement" };
  });
  const pending = h.workerService.refreshGitHubBinding(h.identity, 0);
  await entered.promise;
  h.releaseSource();
  release.resolve();
  await expect(pending).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
  expect(revoke).toHaveBeenCalledOnce();
});

it("revalidates a prepared heartbeat at delivery and stops renewing after terminal ACK", async () => {
  const h = await support.placementHarness("github-delivery", "github-delivery-session", {
    liveEvents: support.sequencedLiveEvents().liveEvents,
  });
  const refresh = vi.fn(async () => ({ generation: 1, token: "synthetic-replacement" }));
  bindHeartbeat(h, refresh);
  const prepared = await h.workerService.refreshGitHubBinding(h.identity, 0);
  assert(prepared.ok, "Expected admitted heartbeat");
  expect(prepared.result?.token).toBe("synthetic-replacement");
  await h.workerService.pushLiveEvent(h.identity, support.terminalEvent(h.identity));
  expect(prepared.result).toBeUndefined();
  const terminal = await h.workerService.refreshGitHubBinding(h.identity, 0);
  expect(terminal).toMatchObject({ ok: true, result: undefined });
  expect(refresh).toHaveBeenCalledOnce();
  h.releaseSource();
  expect(() => prepared.assertCurrent()).toThrow();
});
