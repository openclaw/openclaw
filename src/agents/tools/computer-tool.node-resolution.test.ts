import { Value } from "typebox/value";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDesktopSessionRegistry } from "../../gateway/desktop/session-registry.js";
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
import {
  callGatewayToolMock,
  createComputerTool,
  type ComputerToolOptions,
  gatewayComputerStatusMock,
  listNodesMock,
  macComputerNode,
  screenshotPayload,
  sleepMock,
  v2Descriptor,
} from "./computer-tool.test-helpers.js";
import { wrapToolWithGatewayCallerIdentity } from "./gateway-caller-context.js";

function ownedComputer(
  options: ComputerToolOptions = {},
  caller?: Parameters<typeof wrapToolWithGatewayCallerIdentity>[1],
) {
  let cleanup: ((reason: string) => Promise<void>) | undefined;
  const tool = createComputerTool({
    ...options,
    registerRunCleanup: (registered) => {
      cleanup = registered;
    },
  });
  if (!cleanup) {
    throw new Error("Computer execution did not register cleanup");
  }
  return { tool: caller ? wrapToolWithGatewayCallerIdentity(tool, caller) : tool, cleanup };
}

function attachedDesktopHarness(desktopRegistry?: ReturnType<typeof createDesktopSessionRegistry>) {
  const h = createHarness();
  h.releaseClaim();
  h.state.environment = { ...h.state.environment, state: "ready", attachedSessionIds: [] };
  const computers = createWorkerComputerService({ ...h.options, desktopRegistry });
  const attachment = {
    environmentId: h.state.environment.environmentId,
    ownerEpoch: h.state.environment.ownerEpoch,
    sessionId: h.claim.sessionId,
    sessionKey: h.state.placement.sessionKey,
    agentId: h.state.placement.agentId,
    generation: 1,
  };
  const cleanups: Array<(reason: string) => Promise<void>> = [];
  onTestFinished(async () => {
    try {
      await Promise.all(cleanups.map((cleanup) => cleanup("test-complete")));
    } finally {
      await computers.close();
      await desktopRegistry?.stopAll();
      releaseAgentRunDelegatedAuthority(h.authority);
      resetPluginRuntimeStateForTest();
      vi.restoreAllMocks();
    }
  });
  const fixture = {
    h,
    computers,
    attachment,
    input(action: string, fields: Record<string, unknown> = {}) {
      return { action, environmentId: attachment.environmentId, ...fields };
    },
    async prepare(authority: Parameters<typeof computers.prepareAttached>[0]) {
      const prepared = await computers.prepareAttached(authority);
      if (!prepared) {
        throw new Error("Expected attached computer");
      }
      return prepared;
    },
    tool(context: GatewayRequestContext, options: ComputerToolOptions = {}) {
      const owned = ownedComputer(options, fixture.caller(context));
      cleanups.push(owned.cleanup);
      return owned.tool;
    },
    provideScreenshots() {
      const originalInvoke = h.privateInvoke.getMockImplementation()!;
      h.privateInvoke.mockImplementation(async (invocation) => {
        const result = await originalInvoke(invocation);
        const input = parseNodeWorkerComputerInput(JSON.stringify(invocation.params));
        return result.ok && input.operation === "snapshot"
          ? { ...result, payload: screenshotPayload().payload }
          : result;
      });
    },
    context(prepareAttachedComputer = computers.prepareAttached) {
      return {
        workerEnvironmentService: {
          findSessionAttachment: () => attachment,
          assertSessionAttachment: () => {},
          touchSessionAttachment: async () => {},
          prepareAttachedComputer,
        },
      } as unknown as GatewayRequestContext;
    },
    caller(context: GatewayRequestContext) {
      return {
        agentId: attachment.agentId,
        sessionKey: attachment.sessionKey,
        operationalRunInstance: h.run,
        approvalAuthority: h.authority,
        gatewayContextResolver: () => context,
        receiptAuthority: () => validateAgentRunDelegatedAuthority(h.authority),
      };
    },
  };
  return fixture;
}

function expectNoPairedCalls() {
  expect(listNodesMock).not.toHaveBeenCalled();
  expect(callGatewayToolMock).not.toHaveBeenCalled();
}

function expectSnapshotNode(nodeId: string) {
  expect(callGatewayToolMock).toHaveBeenLastCalledWith(
    "node.invoke",
    expect.anything(),
    expect.objectContaining({ nodeId, command: "screen.snapshot" }),
    { signal: undefined },
  );
}

function cleanupError(failure: Error) {
  return { message: "computer: session desktop cleanup failed", errors: [failure] };
}

function expectClosed(call: Promise<unknown>) {
  return expect(call).rejects.toThrow("computer: execution is closed");
}

function snapshotOrFail(command: string, failure: Error) {
  if (command === "computer.act") {
    throw failure;
  }
  return screenshotPayload();
}

beforeEach(() => {
  listNodesMock.mockReset();
  callGatewayToolMock.mockReset();
  gatewayComputerStatusMock.mockReset().mockResolvedValue({ configured: false, available: false });
  sleepMock.mockReset().mockResolvedValue(undefined);
});

it("never forwards attached-desktop takeover to an ordinary paired node", async () => {
  listNodesMock.mockResolvedValue([macComputerNode()]);
  const tool = createComputerTool();
  await expect(
    tool.execute("takeover", { action: "take_control", target: "node" }),
  ).rejects.toThrow("only available for an attached or session desktop");
  expect(callGatewayToolMock).not.toHaveBeenCalled();
});

it("takes over the selected conversation attachment through its admitted binding", async () => {
  const desktopRegistry = createDesktopSessionRegistry();
  const fixture = attachedDesktopHarness(desktopRegistry);
  const { environmentId, ownerEpoch } = fixture.attachment;
  const context = fixture.context();
  await desktopRegistry.activate({ sourceKey: environmentId, ownerEpoch });
  const observe = () => {
    const close = vi.fn();
    desktopRegistry.attachObserver(environmentId, { control: true, ownerEpoch, close });
    return close;
  };
  const close = observe();
  fixture.provideScreenshots();
  const createTool = () => fixture.tool(context, { idempotencyScope: fixture.h.run.runId });
  const tool = createTool();
  await expect(
    tool.execute("paused", fixture.input("type", { text: "must not type" })),
  ).rejects.toThrow("take_control");
  const takeover = { action: "take_control", environmentId };
  const result = await tool.execute("resume", takeover);
  expect(close).toHaveBeenCalledExactlyOnceWith(4000, "control-taken:Agent");
  expect(result.details).toMatchObject({ ...takeover, frameId: expect.any(String) });
  await tool.execute("continue", { action: "type", text: "resumed" });
  const reclaimedClose = observe();
  await expect(createTool().execute("resume", takeover)).rejects.toThrow(
    "operator took control again",
  );
  expect(reclaimedClose).not.toHaveBeenCalled();
  expectNoPairedCalls();
});

it("keeps a bound session desktop's frames, actions, and cleanup on its transport", async () => {
  listNodesMock.mockResolvedValue([macComputerNode()]);
  callGatewayToolMock.mockResolvedValue(screenshotPayload());
  const computerUse = v2Descriptor(["screenshot", "left_click", "get_window_state"], {
    targets: ["screen", "window"],
    deliveryModes: ["foreground"],
    observations: ["image"],
  });
  const resolveNode = vi.fn<ComputerToolTransport["resolveNode"]>(async (query) => {
    if (query !== undefined && query !== "session-desktop") {
      throw new Error("Computer target is bound to this session desktop");
    }
    return { nodeId: "session-desktop" };
  });
  const invoke = vi.fn<ComputerToolTransport["invoke"]>(async ({ command }) =>
    command === "screen.snapshot" ? screenshotPayload().payload : { ok: true },
  );
  const { tool, cleanup } = ownedComputer({ transport: { computerUse, resolveNode, invoke } });
  const schema = tool.parameters as { properties: Record<string, unknown> };
  const expectBoundSurface = () => {
    expect(tool.description).toContain("this session's desktop");
    expect(tool.description).toContain("get_window_state");
    expect(schema.properties.action).toMatchObject({
      enum: [...computerUse.actions, "wait", "take_control"],
    });
    for (const selector of ["target", "node", "gatewayUrl", "gatewayToken", "timeoutMs"]) {
      expect(schema.properties).not.toHaveProperty(selector);
    }
  };
  expectBoundSurface();
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
  expect(invoke.mock.calls.map(([request]) => request)).toMatchObject([
    { command: "screen.snapshot" },
    {
      nodeId: "session-desktop",
      command: "computer.act",
      commandParams: { action: "left_click", displayFrameId: "display-0-frame", x: 0, y: 0 },
    },
    { command: "screen.snapshot" },
    {
      nodeId: "session-desktop",
      command: "computer.act",
      commandParams: {
        action: "__close_execution",
        executionId: invoke.mock.calls[0]?.[0].commandParams.executionId,
        reason: "completion",
      },
    },
  ]);
  expectNoPairedCalls();
  expectBoundSurface();
  await expectClosed(tool.execute("after-close", { action: "wait", duration: 0 }));
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
  const transport = { resolveNode: async () => ({ nodeId: "session-desktop" }), invoke };
  const { tool, cleanup } = ownedComputer({ transport });
  const first = tool.execute("capture", { action: "screenshot" });
  await captureStarted.promise;
  const queued = expectClosed(tool.execute("queued", { action: "type", text: "unsafe" }));
  const closing = cleanup("cancellation");
  const retained = expectClosed(tool.execute("retained", { action: "type", text: "unsafe" }));
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
  expectNoPairedCalls();
});

it.each([false, true])(
  "keeps cleanup custody when an attached binding resolves after cancellation (close fails=%s)",
  async (closeFails) => {
    const fixture = attachedDesktopHarness();
    const { h, computers, attachment } = fixture;
    const lifetime = new AbortController();
    const closing = createDeferredCore<PromiseSettledResult<void>>();
    const failure = new Error("attached desktop close failed");
    const close = vi.fn<PreparedWorkerComputer["close"]>();
    const context = fixture.context(async (authority) => {
      const prepared = await fixture.prepare(authority);
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
            // Retire after resolver validation, before its caller receives the same promise.
            void resolved.then(
              () =>
                queueMicrotask(() => {
                  lifetime.abort();
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
    });
    const caller = { ...fixture.caller(context), approvalSignals: [lifetime.signal] };
    const { tool, cleanup } = ownedComputer({}, caller);
    await expectClosed(
      tool.execute(
        "pending-binding",
        fixture.input("type", { text: "must not reach the desktop" }),
        lifetime.signal,
      ),
    );
    const outcome = await closing.promise;
    await cleanup("cancellation").catch(() => {});
    expect(h.nativeExecutionIds).toEqual([]);
    expect.soft(close).toHaveBeenCalledExactlyOnceWith("execution-complete");
    const expected = closeFails
      ? { status: "rejected", reason: cleanupError(failure) }
      : { status: "fulfilled" };
    expect.soft(outcome).toMatchObject(expected);
    if (!closeFails) {
      await computers.closeEnvironment(attachment.environmentId, attachment.ownerEpoch);
      expect.soft(close).toHaveBeenCalledTimes(1);
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
    const fixture = attachedDesktopHarness();
    const { h, computers, attachment } = fixture;
    const preparations: PreparedWorkerComputer[] = [];
    const closeAttempts = vi.fn<(index: number, reason: string) => void>();
    const failure = new Error("unused attached desktop close failed");
    const context = fixture.context(async (authority) => {
      const prepared = await fixture.prepare(authority);
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
    });
    fixture.provideScreenshots();
    const { tool, cleanup } = ownedComputer({}, fixture.caller(context));
    const rejectedInput = fixture.input("type", { text: "" });
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
      const result = await tool.execute("recover", fixture.input("screenshot"));
      expect(result.content.some((part) => part.type === "image")).toBe(true);
      expect(result.details).toMatchObject({
        node: h.state.node.nodeId,
        environmentId: attachment.environmentId,
      });
    }
    const operations = () =>
      h.privateInvoke.mock.calls
        .map(([{ params }]) => parseNodeWorkerComputerInput(JSON.stringify(params)).operation)
        .filter((operation) => operation !== "capabilities");
    expect(operations()).toEqual(nextAction === "screenshot" ? ["snapshot"] : []);
    if (closeFails) {
      await expect.soft(cleanup("completed")).rejects.toMatchObject(cleanupError(failure));
    } else {
      await cleanup("completed");
    }
    await cleanup("completed").catch(() => {});
    expect
      .soft(closeAttempts.mock.calls.map(([index]) => index).toSorted((a, b) => a - b))
      .toEqual(preparations.map((_prepared, index) => index));
    expect(operations()).toEqual(nextAction === "screenshot" ? ["snapshot", "close"] : []);
    if (nextAction === "screenshot") {
      expect(h.nativeExecutionIds).toEqual([h.nativeExecutionIds[0], h.nativeExecutionIds[0]]);
    }
    await computers.closeEnvironment(attachment.environmentId, attachment.ownerEpoch);
    expect.soft(closeAttempts).toHaveBeenCalledTimes(preparations.length + Number(closeFails));
  },
);

it.each(["paired", "session"] as const)(
  "reports cleanup failure only to the bound owner of a %s desktop",
  async (targetScope) => {
    const failure = new Error("desktop disconnected during cleanup");
    listNodesMock.mockResolvedValue([macComputerNode()]);
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) =>
      snapshotOrFail(body.command, failure),
    );
    const invoke = vi.fn<ComputerToolTransport["invoke"]>(
      async ({ command }) => snapshotOrFail(command, failure).payload,
    );
    const { tool, cleanup } = ownedComputer({
      transport:
        targetScope === "session"
          ? { resolveNode: async () => ({ nodeId: "session-desktop" }), invoke }
          : undefined,
    });
    await tool.execute("observe", { action: "screenshot" });
    if (targetScope === "session") {
      await expect(cleanup("completion")).rejects.toMatchObject(cleanupError(failure));
    } else {
      await expect(cleanup("completion")).resolves.toBeUndefined();
    }
  },
);

it.each([
  {
    nodes: [
      macComputerNode({ connected: false }),
      { nodeId: "phone", platform: "ios", connected: true, commands: [] },
    ],
    error: /no connected computer-capable node/,
  },
  ...["requested-desktop", "Requested-Desktop"].map((nodeId) => ({
    nodes: [
      macComputerNode({ nodeId, displayName: "Disabled", commands: ["screen.snapshot"] }),
      macComputerNode({ nodeId: "mac-ready", displayName: "requested-desktop" }),
    ],
    node: "requested-desktop",
    error: /node "requested-desktop" is not computer-capable.*eligible node ids: mac-ready/,
  })),
  {
    nodes: [
      macComputerNode({
        nodeId: "mac-a",
        displayName: "Shared Desktop",
        clientId: "openclaw-macos",
      }),
      macComputerNode({ nodeId: "mac-b", displayName: "Shared Desktop", clientId: "node-host" }),
    ],
    node: "Shared Desktop",
    error:
      /ambiguous node: Shared Desktop.*node=mac-a.*node=mac-b.*eligible computer-capable node ids: mac-a, mac-b/,
  },
  {
    nodes: [macComputerNode({ nodeId: "mac-a" }), macComputerNode({ nodeId: "mac-b" })],
    error: /multiple computer-capable nodes connected; pass node explicitly: mac-a, mac-b/,
  },
  {
    nodes: [
      { nodeId: "desktop-1", platform: "windows", connected: true, commands: ["computer.act"] },
    ],
    node: "desktop-1",
    error: /advertising computer\.act and screen\.snapshot/,
  },
])("rejects selector $node with $error (case %#)", async ({ nodes, node, error }) => {
  listNodesMock.mockResolvedValue(nodes);
  const tool = createComputerTool();
  await expect(tool.execute("call", { action: "screenshot", node })).rejects.toThrow(error);
  expect(callGatewayToolMock).not.toHaveBeenCalled();
});

it.each([
  [
    "Studio Desktop",
    macComputerNode({ nodeId: "mac-other", displayName: "Other Desktop" }),
    macComputerNode({ nodeId: "mac-ready", displayName: "Studio Desktop" }),
  ],
  [
    "mac-ready",
    macComputerNode({ nodeId: "mac-ready", displayName: "Studio" }),
    macComputerNode({ nodeId: "mac-off", displayName: "mac-ready", commands: [] }),
  ],
] as const)("resolves eligible selector %s without redirecting it", async (node, first, second) => {
  listNodesMock.mockResolvedValue([first, second]);
  callGatewayToolMock.mockResolvedValue(screenshotPayload());
  const tool = createComputerTool();
  await expect(tool.execute("call", { action: "screenshot", node })).resolves.toBeDefined();
  expectSnapshotNode("mac-ready");
});

it("prepares blank selectors before validation and resolves a capable Windows node", async () => {
  listNodesMock.mockResolvedValue([macComputerNode({ platform: "windows" })]);
  callGatewayToolMock.mockResolvedValue(screenshotPayload());
  for (const selectors of [
    {},
    { target: "", node: "", environmentId: "" },
    { target: " \t", node: "\n", environmentId: "  " },
  ]) {
    const tool = createComputerTool();
    const args = { action: "screenshot", ...selectors };
    const prepared = tool.prepareArguments?.(args) ?? args;
    expect(Value.Check(tool.parameters, prepared)).toBe(true);
    const result = await tool.execute("call", prepared);
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "image" })]),
    );
    expectSnapshotNode("mac-1");
  }
});
