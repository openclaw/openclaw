/**
 * computer tool node-resolution tests.
 *
 * Cover which paired node a call binds to: capability eligibility, explicit
 * node selectors, and the id-before-display-name precedence that keeps input
 * off the wrong machine.
 */
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { createWorkerComputerService } from "../../gateway/worker-environments/computer-service.js";
import type { PreparedWorkerComputer } from "../../gateway/worker-environments/computer-transport.js";
import { createHarness } from "../../gateway/worker-environments/computer-transport.test-support.js";
import {
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { parseNodeWorkerComputerInput } from "../../worker/node-computer-protocol.js";
import type { ComputerToolTransport } from "./computer-tool.js";
import { wrapToolWithGatewayCallerIdentity } from "./gateway-caller-context.js";

const listNodesMock = vi.fn();
const callGatewayToolMock = vi.fn();
const sleepMock = vi.hoisted(() => vi.fn());
const gatewayComputerStatusMock = vi.hoisted(() => vi.fn());
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

vi.mock("./nodes-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./nodes-utils.js")>();
  return { ...actual, listNodes: listNodesMock };
});

vi.mock("./gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway.js")>();
  return { ...actual, callGatewayTool: callGatewayToolMock };
});

vi.mock("../../utils/sleep.js", () => ({ sleep: sleepMock }));
vi.mock("./computer-tool-gateway.js", () => ({
  loadGatewayComputerStatus: gatewayComputerStatusMock,
  bindGatewayComputerCleanup: async () => undefined,
}));

const { createComputerTool } = await import("./computer-tool.js");

function macComputerNode(overrides?: Record<string, unknown>) {
  return {
    nodeId: "mac-1",
    displayName: "Studio",
    platform: "macos",
    connected: true,
    commands: ["screen.snapshot", "computer.act"],
    ...overrides,
  };
}

function screenshotPayload(screenIndex = 0, base64 = TINY_PNG_BASE64) {
  return {
    payload: {
      format: "png",
      base64,
      displayFrameId: `display-${screenIndex}-frame`,
      width: 1280,
      height: 800,
      screenIndex,
    },
  };
}

describe("createComputerTool node resolution", () => {
  beforeEach(() => {
    listNodesMock.mockReset();
    callGatewayToolMock.mockReset();
    gatewayComputerStatusMock.mockReset();
    gatewayComputerStatusMock.mockResolvedValue({ configured: false, available: false });
    sleepMock.mockReset();
    sleepMock.mockResolvedValue(undefined);
  });

  it("errors when no computer-capable node is connected", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({ connected: false }),
      { nodeId: "phone", platform: "ios", connected: true, commands: [] },
    ]);
    const tool = createComputerTool({ modelHasVision: true });
    await expect(tool.execute("call", { action: "screenshot" })).rejects.toThrow(
      /no connected computer-capable node/,
    );
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("keeps a bound session desktop's frames, actions, and cleanup on its transport", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    callGatewayToolMock.mockResolvedValue(screenshotPayload());
    const computerUse: NonNullable<ComputerToolTransport["computerUse"]> = {
      contractVersion: 2,
      provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
      actions: ["screenshot", "left_click", "get_window_state"],
      targets: ["screen", "window"],
      deliveryModes: ["foreground"],
      observations: ["image"],
      features: { recording: false, agentCursor: false, multiDisplay: false },
    };
    const resolveNode = vi.fn<ComputerToolTransport["resolveNode"]>(async (query) => {
      if (query !== undefined && query !== "session-desktop") {
        throw new Error("Computer target is bound to this session desktop");
      }
      return { nodeId: "session-desktop" };
    });
    const invoke = vi.fn<ComputerToolTransport["invoke"]>(async ({ command }) =>
      command === "screen.snapshot" ? screenshotPayload().payload : { ok: true },
    );
    let cleanup: ((reason: string) => Promise<void>) | undefined;
    const tool = createComputerTool({
      modelHasVision: true,
      transport: { computerUse, resolveNode, invoke },
      registerRunCleanup: (registered) => {
        cleanup = registered;
      },
    });
    expect(tool.description).toContain("this session's desktop");
    expect(tool.description).toContain("get_window_state");
    const selectors = ["target", "node", "gatewayUrl", "gatewayToken", "timeoutMs"];
    const schema = tool.parameters as { properties: Record<string, unknown> };
    expect(schema.properties.action).toMatchObject({ enum: [...computerUse.actions, "wait"] });
    for (const selector of selectors) {
      expect(schema.properties).not.toHaveProperty(selector);
    }

    const screenshot = await tool.execute("observe", { action: "wait", duration: 0 });
    expect(sleepMock).toHaveBeenCalledWith(0, undefined);
    expect(screenshot.details).toMatchObject({ node: "session-desktop" });
    const frameId = (screenshot.details as { frameId: string }).frameId;
    await tool.execute("click", { action: "left_click", coordinate: [0, 0], frameId });
    await expect(
      tool.execute("wrong-desktop", { action: "screenshot", node: "mac-1" }),
    ).rejects.toThrow("bound to this session desktop");
    await expect(
      tool.execute("wrong-host", { action: "screenshot", target: "gateway" }),
    ).rejects.toThrow("bound to this session's desktop");
    expect(gatewayComputerStatusMock).not.toHaveBeenCalled();
    await cleanup?.("completion");

    expect(invoke.mock.calls.map(([request]) => request.command)).toEqual([
      "screen.snapshot",
      "computer.act",
      "screen.snapshot",
      "computer.act",
    ]);
    const snapshotRequest = invoke.mock.calls[0]?.[0];
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({
      nodeId: "session-desktop",
      commandParams: {
        action: "left_click",
        displayFrameId: "display-0-frame",
        x: 0,
        y: 0,
      },
    });
    expect(invoke.mock.calls[3]?.[0]).toMatchObject({
      nodeId: "session-desktop",
      commandParams: {
        action: "__close_execution",
        executionId: snapshotRequest?.commandParams.executionId,
        reason: "completion",
      },
    });
    expect(listNodesMock).not.toHaveBeenCalled();
    expect(callGatewayToolMock).not.toHaveBeenCalled();
    expect(tool.description).toContain("this session's desktop");
    expect(tool.description).toContain("get_window_state");
    for (const selector of selectors) {
      expect(schema.properties).not.toHaveProperty(selector);
    }
    await expect(tool.execute("after-close", { action: "wait", duration: 0 })).rejects.toThrow(
      "computer: execution is closed",
    );
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it("fences retained and queued calls while awaiting an in-flight capture before cleanup", async () => {
    const capture = createDeferredCore<unknown>();
    const captureStarted = createDeferredCore();
    const invoke = vi.fn<ComputerToolTransport["invoke"]>(async ({ command }) => {
      if (command === "screen.snapshot") {
        captureStarted.resolve();
        return await capture.promise;
      }
      return { ok: true };
    });
    let cleanup: ((reason: string) => Promise<void>) | undefined;
    const tool = createComputerTool({
      modelHasVision: true,
      transport: { resolveNode: async () => ({ nodeId: "session-desktop" }), invoke },
      registerRunCleanup: (registered) => {
        cleanup = registered;
      },
    });
    if (!cleanup) {
      throw new Error("Computer execution did not register cleanup");
    }

    const first = tool.execute("capture", { action: "screenshot" });
    await captureStarted.promise;
    const queued = expect(
      tool.execute("queued", { action: "type", text: "unsafe" }),
    ).rejects.toThrow("computer: execution is closed");
    const closing = cleanup("cancellation");
    const retained = expect(
      tool.execute("retained", { action: "type", text: "unsafe" }),
    ).rejects.toThrow("computer: execution is closed");
    expect(invoke).toHaveBeenCalledOnce();
    capture.resolve(screenshotPayload().payload);
    await first;
    await Promise.all([queued, retained, closing, cleanup("cancellation")]);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({
      nodeId: "session-desktop",
      command: "computer.act",
      commandParams: { action: "__close_execution", reason: "cancellation" },
    });
    expect(callGatewayToolMock).not.toHaveBeenCalled();
    expect(listNodesMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps cleanup custody when an attached binding resolves after cancellation (close fails=%s)",
    async (closeFails) => {
      const h = createHarness();
      h.releaseClaim();
      h.state.environment = { ...h.state.environment, state: "ready", attachedSessionIds: [] };
      const computers = createWorkerComputerService(h.options);
      const lifetime = new AbortController();
      const closing = createDeferredCore<PromiseSettledResult<void>>();
      let cleanup: ((reason: string) => Promise<void>) | undefined;
      const failure = new Error("attached desktop close failed");
      const close = vi.fn<PreparedWorkerComputer["close"]>();
      const attachment = {
        environmentId: h.state.environment.environmentId,
        ownerEpoch: h.state.environment.ownerEpoch,
        sessionId: h.claim.sessionId,
        sessionKey: h.state.placement.sessionKey,
        agentId: h.state.placement.agentId,
        generation: 1,
      };
      const context = {
        workerEnvironmentService: {
          findSessionAttachment: () => attachment,
          assertSessionAttachment: () => {},
          touchSessionAttachment: async () => {},
          prepareAttachedComputer: async (
            authority: Parameters<typeof computers.prepareAttached>[0],
          ) => {
            const prepared = await computers.prepareAttached(authority);
            if (!prepared) {
              throw new Error("Expected attached computer");
            }
            const originalClose = prepared.close;
            close.mockImplementation(async (reason) => {
              if (closeFails && reason === "execution-complete") {
                throw failure;
              }
              await originalClose(reason);
            });
            prepared.close = close;
            const originalBind = prepared.bind.bind(prepared);
            prepared.bind = (run) => {
              const transport = originalBind(run);
              return {
                ...transport,
                resolveNode: (query, signal) => {
                  const resolved = transport.resolveNode(query, signal);
                  // Retire after the resolver's final assertions, before its caller
                  // receives the binding. Returning the same promise preserves that gap.
                  void resolved.then(
                    () =>
                      queueMicrotask(() => {
                        lifetime.abort();
                        if (!cleanup) {
                          closing.resolve({
                            status: "rejected",
                            reason: new Error("Computer cleanup was not registered"),
                          });
                          return;
                        }
                        void cleanup("cancellation").then(
                          () => closing.resolve({ status: "fulfilled", value: undefined }),
                          (reason: unknown) => closing.resolve({ status: "rejected", reason }),
                        );
                      }),
                    (reason: unknown) => closing.resolve({ status: "rejected", reason }),
                  );
                  return resolved;
                },
              };
            };
            return prepared;
          },
        },
      } as unknown as GatewayRequestContext;
      const tool = wrapToolWithGatewayCallerIdentity(
        createComputerTool({
          registerRunCleanup: (registered) => {
            cleanup = registered;
          },
        }),
        {
          agentId: attachment.agentId,
          sessionKey: attachment.sessionKey,
          operationalRunInstance: h.run,
          approvalAuthority: h.authority,
          approvalSignals: [lifetime.signal],
          gatewayContextResolver: () => context,
          receiptAuthority: () => validateAgentRunDelegatedAuthority(h.authority),
        },
      );
      try {
        if (!cleanup) {
          throw new Error("Computer execution did not register cleanup");
        }
        await expect(
          tool.execute(
            "pending-binding",
            {
              action: "type",
              text: "must not reach the desktop",
              environmentId: attachment.environmentId,
            },
            lifetime.signal,
          ),
        ).rejects.toThrow("computer: execution is closed");
        const outcome = await closing.promise;
        await cleanup("cancellation").catch(() => {});

        expect(h.nativeExecutionIds).toEqual([]);
        expect.soft(close).toHaveBeenCalledExactlyOnceWith("execution-complete");
        expect.soft(outcome).toMatchObject(
          closeFails
            ? {
                status: "rejected",
                reason: { message: "computer: session desktop cleanup failed", errors: [failure] },
              }
            : { status: "fulfilled" },
        );
        if (!closeFails) {
          // Environment shutdown must not discover an owner abandoned by run cleanup.
          const closedBeforeEnvironmentStop = close.mock.calls.length;
          await computers.closeEnvironment(attachment.environmentId, attachment.ownerEpoch);
          expect.soft(close.mock.calls.length - closedBeforeEnvironmentStop).toBe(0);
        }
      } finally {
        await computers.close();
        releaseAgentRunDelegatedAuthority(h.authority);
        resetPluginRuntimeStateForTest();
        vi.restoreAllMocks();
      }
    },
  );

  it.each([
    { nextAction: "type", closeFails: false },
    { nextAction: "screenshot", closeFails: false },
    { nextAction: "screenshot", closeFails: true },
  ] as const)(
    "releases every attached preparation after rejected input followed by $nextAction (discarded close fails=$closeFails)",
    async ({ nextAction, closeFails }) => {
      const h = createHarness();
      h.releaseClaim();
      h.state.environment = { ...h.state.environment, state: "ready", attachedSessionIds: [] };
      const computers = createWorkerComputerService(h.options);
      const preparations: PreparedWorkerComputer[] = [];
      const closeAttempts = vi.fn<(index: number, reason: string) => void>();
      const failure = new Error("unused attached desktop close failed");
      const attachment = {
        environmentId: h.state.environment.environmentId,
        ownerEpoch: h.state.environment.ownerEpoch,
        sessionId: h.claim.sessionId,
        sessionKey: h.state.placement.sessionKey,
        agentId: h.state.placement.agentId,
        generation: 1,
      };
      const context = {
        workerEnvironmentService: {
          findSessionAttachment: () => attachment,
          assertSessionAttachment: () => {},
          touchSessionAttachment: async () => {},
          prepareAttachedComputer: async (
            authority: Parameters<typeof computers.prepareAttached>[0],
          ) => {
            const prepared = await computers.prepareAttached(authority);
            if (!prepared) {
              throw new Error("Expected attached computer");
            }
            const index = preparations.length;
            preparations.push(prepared);
            const originalClose = prepared.close.bind(prepared);
            prepared.close = async (reason) => {
              closeAttempts(index, reason);
              if (closeFails && index === 1 && reason === "execution-complete") {
                throw failure;
              }
              await originalClose(reason);
            };
            return prepared;
          },
        },
      } as unknown as GatewayRequestContext;
      const originalInvoke = h.privateInvoke.getMockImplementation();
      if (!originalInvoke) {
        throw new Error("Expected native computer transport");
      }
      h.privateInvoke.mockImplementation(async (invocation) => {
        const result = await originalInvoke(invocation);
        const input = parseNodeWorkerComputerInput(JSON.stringify(invocation.params));
        return result.ok && input.operation === "snapshot"
          ? { ...result, payload: screenshotPayload().payload }
          : result;
      });
      let cleanup: ((reason: string) => Promise<void>) | undefined;
      const tool = wrapToolWithGatewayCallerIdentity(
        createComputerTool({
          modelHasVision: true,
          registerRunCleanup: (registered) => {
            cleanup = registered;
          },
        }),
        {
          agentId: attachment.agentId,
          sessionKey: attachment.sessionKey,
          operationalRunInstance: h.run,
          approvalAuthority: h.authority,
          gatewayContextResolver: () => context,
          receiptAuthority: () => validateAgentRunDelegatedAuthority(h.authority),
        },
      );
      try {
        if (!cleanup) {
          throw new Error("Computer execution did not register cleanup");
        }
        const rejectedInput = {
          action: "type",
          text: "",
          environmentId: attachment.environmentId,
        };
        await expect(tool.execute("invalid-first", rejectedInput)).rejects.toThrow(
          "text required for type",
        );
        expect(preparations).toHaveLength(1);
        expect(h.nativeExecutionIds).toEqual([]);

        if (nextAction === "type") {
          await expect(tool.execute("invalid-next", rejectedInput)).rejects.toThrow(
            "text required for type",
          );
        } else {
          const result = await tool.execute("recover", {
            action: "screenshot",
            environmentId: attachment.environmentId,
          });
          expect(result.content.some((part) => part.type === "image")).toBe(true);
          expect(result.details).toMatchObject({
            node: h.state.node.nodeId,
            environmentId: attachment.environmentId,
          });
        }
        const operations = () =>
          h.privateInvoke.mock.calls
            .map(([invocation]) => parseNodeWorkerComputerInput(JSON.stringify(invocation.params)))
            .map((input) => input.operation)
            .filter((operation) => operation !== "capabilities");
        expect(operations()).toEqual(nextAction === "screenshot" ? ["snapshot"] : []);
        if (closeFails) {
          await expect.soft(cleanup("completed")).rejects.toMatchObject({
            message: "computer: session desktop cleanup failed",
            errors: [failure],
          });
        } else {
          await cleanup("completed");
        }
        await cleanup("completed").catch(() => {});

        // Each preparation has its own service owner, even when target selection
        // keeps an earlier binding. Run cleanup must release all of those owners.
        expect
          .soft(closeAttempts.mock.calls.map(([index]) => index).toSorted((a, b) => a - b))
          .toEqual(preparations.map((_prepared, index) => index));
        expect(operations()).toEqual(nextAction === "screenshot" ? ["snapshot", "close"] : []);
        if (nextAction === "screenshot") {
          expect(h.nativeExecutionIds).toHaveLength(2);
          expect(h.nativeExecutionIds[1]).toBe(h.nativeExecutionIds[0]);
        }
        const closesBeforeEnvironmentStop = closeAttempts.mock.calls.length;
        await computers.closeEnvironment(attachment.environmentId, attachment.ownerEpoch);
        expect
          .soft(closeAttempts.mock.calls.length - closesBeforeEnvironmentStop)
          .toBe(closeFails ? 1 : 0);
      } finally {
        await computers.close();
        releaseAgentRunDelegatedAuthority(h.authority);
        resetPluginRuntimeStateForTest();
        vi.restoreAllMocks();
      }
    },
  );

  it.each(["paired", "session"] as const)(
    "reports cleanup failure only to the bound owner of a %s desktop",
    async (targetScope) => {
      const failure = new Error("desktop disconnected during cleanup");
      listNodesMock.mockResolvedValue([macComputerNode()]);
      callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
        if (body.command === "computer.act") {
          throw failure;
        }
        return screenshotPayload();
      });
      const invoke = vi.fn<ComputerToolTransport["invoke"]>(async ({ command }) => {
        if (command === "computer.act") {
          throw failure;
        }
        return screenshotPayload().payload;
      });
      let cleanup: ((reason: string) => Promise<void>) | undefined;
      const tool = createComputerTool({
        modelHasVision: true,
        transport:
          targetScope === "session"
            ? { resolveNode: async () => ({ nodeId: "session-desktop" }), invoke }
            : undefined,
        registerRunCleanup: (registered) => {
          cleanup = registered;
        },
      });
      if (!cleanup) {
        throw new Error("Computer execution did not register cleanup");
      }
      await tool.execute("observe", { action: "screenshot" });

      if (targetScope === "session") {
        await expect(cleanup("completion")).rejects.toMatchObject({
          message: "computer: session desktop cleanup failed",
          errors: [failure],
        });
      } else {
        await expect(cleanup("completion")).resolves.toBeUndefined();
      }
    },
  );

  it.each(["windows", "linux"])("resolves and executes on a capable %s node", async (platform) => {
    const nodeId = `${platform}-1`;
    listNodesMock.mockResolvedValue([
      {
        nodeId,
        displayName: `${platform} desktop`,
        platform,
        connected: true,
        commands: ["computer.act", "screen.snapshot"],
      },
    ]);
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) =>
      (body as { command?: string }).command === "computer.act"
        ? { payload: { ok: true } }
        : screenshotPayload(),
    );
    const tool = createComputerTool({ modelHasVision: true });

    await expect(tool.execute("call", { action: "type", text: "hello" })).resolves.toBeDefined();
    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "node.invoke",
      expect.anything(),
      expect.objectContaining({ nodeId, command: "computer.act" }),
      { signal: undefined },
    );
  });

  it("reports the eligible node ids when an exact id names an ineligible machine", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({ nodeId: "mac-disabled", commands: ["screen.snapshot"] }),
      macComputerNode({ nodeId: "mac-ready" }),
    ]);
    const tool = createComputerTool({ modelHasVision: true });
    await expect(
      tool.execute("call", { action: "screenshot", node: "mac-disabled" }),
    ).rejects.toThrow(/node "mac-disabled" is not computer-capable.*eligible node ids: mac-ready/);
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("never redirects an ineligible exact id to an eligible node with that display name", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({
        nodeId: "requested-desktop",
        displayName: "Disabled",
        commands: ["screen.snapshot"],
      }),
      macComputerNode({ nodeId: "mac-ready", displayName: "requested-desktop" }),
    ]);
    const tool = createComputerTool({ modelHasVision: true });
    await expect(
      tool.execute("call", { action: "screenshot", node: "requested-desktop" }),
    ).rejects.toThrow(/node "requested-desktop" is not computer-capable/);
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("rejects a case-insensitive ineligible id before an eligible display-name match", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({
        nodeId: "Requested-Desktop",
        displayName: "Disabled",
        commands: ["screen.snapshot"],
      }),
      macComputerNode({ nodeId: "mac-ready", displayName: "requested-desktop" }),
    ]);
    const tool = createComputerTool({ modelHasVision: true });
    await expect(
      tool.execute("call", { action: "screenshot", node: "requested-desktop" }),
    ).rejects.toThrow(/is not computer-capable/);
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("rejects an ambiguous eligible display-name match across current clients", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({
        nodeId: "mac-a",
        displayName: "Shared Desktop",
        clientId: "openclaw-macos",
      }),
      macComputerNode({ nodeId: "mac-b", displayName: "Shared Desktop", clientId: "node-host" }),
    ]);
    const tool = createComputerTool({ modelHasVision: true });
    await expect(
      tool.execute("call", { action: "screenshot", node: "Shared Desktop" }),
    ).rejects.toThrow(
      /ambiguous node: Shared Desktop.*node=mac-a.*node=mac-b.*eligible computer-capable node ids: mac-a, mac-b/,
    );
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("resolves an eligible node by display name", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({ nodeId: "mac-other", displayName: "Other Desktop" }),
      macComputerNode({ nodeId: "mac-ready", displayName: "Studio Desktop" }),
    ]);
    callGatewayToolMock.mockResolvedValue(screenshotPayload());
    const tool = createComputerTool({ modelHasVision: true });

    await expect(
      tool.execute("call", { action: "screenshot", node: "Studio Desktop" }),
    ).resolves.toBeDefined();
    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "node.invoke",
      expect.anything(),
      expect.objectContaining({ nodeId: "mac-ready", command: "screen.snapshot" }),
      { signal: undefined },
    );
  });

  it("selects an exact eligible id over an ineligible display-name collision", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({ nodeId: "mac-ready", displayName: "Studio" }),
      macComputerNode({ nodeId: "mac-off", displayName: "mac-ready", commands: [] }),
    ]);
    callGatewayToolMock.mockResolvedValue(screenshotPayload());
    const tool = createComputerTool({ modelHasVision: true });

    await expect(
      tool.execute("call", { action: "screenshot", node: "mac-ready" }),
    ).resolves.toBeDefined();
    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "node.invoke",
      expect.anything(),
      expect.objectContaining({ nodeId: "mac-ready", command: "screen.snapshot" }),
      { signal: undefined },
    );
  });

  it("prepares blank selectors before validation and reaches the same node as omitted selectors", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    callGatewayToolMock.mockResolvedValue(screenshotPayload());
    for (const selectors of [
      {},
      { target: "", node: "", environmentId: "" },
      { target: " \t", node: "\n", environmentId: "  " },
    ]) {
      const tool = createComputerTool({ modelHasVision: true });
      const args = { action: "screenshot", ...selectors };
      const prepared = tool.prepareArguments?.(args) ?? args;
      expect(Value.Check(tool.parameters, prepared)).toBe(true);
      const result = await tool.execute("call", prepared);
      expect(result.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "image" })]),
      );
      expect(callGatewayToolMock).toHaveBeenLastCalledWith(
        "node.invoke",
        expect.anything(),
        expect.objectContaining({ nodeId: "mac-1", command: "screen.snapshot" }),
        { signal: undefined },
      );
    }
  });

  it("leaves nonblank invalid targets for validation and unknown nodes for resolution", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    const tool = createComputerTool({ modelHasVision: true });
    const invalidTarget = { action: "screenshot", target: "foo" };
    expect(Value.Check(tool.parameters, tool.prepareArguments?.(invalidTarget))).toBe(false);
    const unknownNode = { action: "screenshot", node: "unknown-node" };
    await expect(tool.execute("call", tool.prepareArguments?.(unknownNode))).rejects.toThrow(
      /unknown node/,
    );
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("requires an explicit node when several computer-capable nodes are connected", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({ nodeId: "mac-a" }),
      macComputerNode({ nodeId: "mac-b" }),
    ]);
    const tool = createComputerTool({ modelHasVision: true });
    await expect(tool.execute("call", { action: "screenshot" })).rejects.toThrow(
      /multiple computer-capable nodes connected; pass node explicitly: mac-a, mac-b/,
    );
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("rejects a node advertising computer.act without screen.snapshot", async () => {
    listNodesMock.mockResolvedValue([
      { nodeId: "desktop-1", platform: "windows", connected: true, commands: ["computer.act"] },
    ]);
    const tool = createComputerTool({ modelHasVision: true });
    await expect(tool.execute("call", { action: "screenshot", node: "desktop-1" })).rejects.toThrow(
      /advertising computer\.act and screen\.snapshot/,
    );
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });
});
