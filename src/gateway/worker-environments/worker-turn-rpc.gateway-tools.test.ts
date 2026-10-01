import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { bindAgentToolExecutionLocation } from "../../agents/agent-tool-metadata.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { getWorkerTurnToolSurface } from "./placement-turn-claim-events.js";
import * as support from "./service.test-support.js";
import { createWorkerGatewayToolRuntime } from "./worker-gateway-tool-runtime.js";

async function toolHarness(name: string) {
  const fixture = await support.placementHarness(`worker-${name}`, `session-${name}`);
  let sourceCurrent = true;
  const assertSource = vi.fn(() => {
    fixture.source.receiptAuthority();
    if (!sourceCurrent) {
      throw new Error("Source transcript writer changed");
    }
  });
  const execute = vi.fn<AnyAgentTool["execute"]>(async () => ({
    content: [],
    details: { ok: true },
  }));
  const tool: AnyAgentTool = {
    name: "portal",
    label: "Portal",
    description: "Open a portal",
    parameters: Type.Object(
      { action: Type.Literal("open"), port: Type.Optional(Type.Integer()) },
      { additionalProperties: false },
    ),
    execute: async (...args) => {
      assertSource();
      const result = await execute(...args);
      assertSource();
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
  if (!surface.ok) {
    throw new Error("Expected an admitted tool surface");
  }
  const request = {
    generation: surface.result.generation,
    toolId: surface.result.tools[0]!.id,
    toolCallId: "call",
    arguments: { action: "open", port: 3000 },
  };
  const invoke = (input = request) =>
    fixture.workerService.invokeGatewayTool(fixture.identity, input, { send: vi.fn() });
  return {
    ...fixture,
    execute,
    request,
    invoke,
    assertSource,
    invalidateSource: () => {
      sourceCurrent = false;
    },
  };
}

describe("worker Gateway tool RPC authority", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("keeps catalog and cancellation available while stale source authority fences effects", async () => {
    const h = await toolHarness("source-custody");
    h.invalidateSource();
    await expect(h.workerService.getToolSurface(h.identity)).resolves.toMatchObject({ ok: true });
    await expect(
      h.workerService.cancelGatewayTool(h.identity, {
        generation: h.request.generation,
        toolCallId: h.request.toolCallId,
      }),
    ).resolves.toMatchObject({ ok: true, result: { cancelled: false } });
    expect(h.assertSource).not.toHaveBeenCalled();
    await expect(h.invoke()).resolves.toMatchObject({
      ok: true,
      result: { details: { error: "Source transcript writer changed" } },
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("accepts only issued handles and canonical arguments before dispatch", async () => {
    const h = await toolHarness("tool-authority");
    for (const request of [
      { ...h.request, generation: "old-generation" },
      { ...h.request, toolId: "unissued" },
      { ...h.request, arguments: { action: "delete", port: 3000 } },
    ]) {
      await expect(h.invoke(request)).resolves.toMatchObject({
        ok: true,
        result: { details: { status: "error" } },
      });
    }
    expect(h.execute).not.toHaveBeenCalled();
    await expect(h.invoke()).resolves.toMatchObject({
      ok: true,
      result: { details: { ok: true } },
    });
    expect(h.execute).toHaveBeenCalledOnce();
    h.placementStore.validateWorkerTurn.mockReturnValue(false);
    await expect(h.invoke()).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    expect(h.execute).toHaveBeenCalledOnce();
  });

  it("cancels an issued invocation before its first yield without starting the tool", async () => {
    const h = await toolHarness("cancel-before-yield");
    const [invoked, cancelled] = await Promise.all([
      h.invoke(),
      h.workerService.cancelGatewayTool(h.identity, {
        generation: h.request.generation,
        toolCallId: h.request.toolCallId,
      }),
    ]);
    expect(cancelled).toEqual({ ok: true, result: { cancelled: true } });
    expect(invoked).toMatchObject({
      ok: true,
      result: { details: { status: "error", error: "Worker tool call cancelled" } },
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("returns actionable tool failures to an authorized worker", async () => {
    const h = await toolHarness("tool-error");
    h.execute.mockRejectedValueOnce(new Error("portal port required"));
    await expect(h.invoke()).resolves.toMatchObject({
      ok: true,
      result: {
        content: [{ type: "text", text: expect.stringContaining("portal port required") }],
        details: { status: "error", error: "portal port required" },
      },
    });
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
          return { content: [], details: { ok: true } };
        });
        await expect(h.invoke()).resolves.toMatchObject({ ok: false });
        await expect(h.workerService.getToolSurface(h.identity)).resolves.toMatchObject({
          ok: false,
        });
        await expect(
          h.workerService.cancelGatewayTool(h.identity, {
            generation: h.request.generation,
            toolCallId: h.request.toolCallId,
          }),
        ).resolves.toMatchObject({ ok: false });
      }
    },
  );
});
