import { beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";

const listNodesMock = vi.fn();
const callGatewayToolMock = vi.fn();

vi.mock("./nodes-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./nodes-utils.js")>();
  return { ...actual, listNodes: listNodesMock };
});

vi.mock("./gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway.js")>();
  return { ...actual, callGatewayTool: callGatewayToolMock };
});

const { createMobileUiTool } = await import("./mobile-ui-tool.js");

const OBSERVE = "mobile.ui.observe";
const ACT = "mobile.ui.act";
const observe = (tool = createMobileUiTool(), extra: Record<string, unknown> = {}) =>
  tool.execute("observe-1", { action: "observe", ...extra });
const act = (
  tool: ReturnType<typeof createMobileUiTool>,
  extra: Record<string, unknown> = {},
  id = "act-1",
) => tool.execute(id, { ...activation, ...extra });

function androidMobileUiNode(overrides?: Record<string, unknown>) {
  return {
    nodeId: "android-1",
    displayName: "Pixel",
    platform: "android",
    connected: true,
    caps: ["mobileUI"],
    commands: [OBSERVE, ACT],
    ...overrides,
  };
}

function snapshotPayload(params?: { id?: string; packageName?: string; text?: string }) {
  return {
    payload: {
      snapshotId: params?.id ?? "snapshot-1",
      package: params?.packageName ?? "example.app",
      windowTitle: "Example",
      nodes: [
        {
          ref: "n1",
          role: "button",
          text: params?.text ?? "Next",
          viewId: "example.app:id/next",
          bounds: [10, 20, 110, 70],
          flags: { clickable: true, enabled: true },
          actions: ["activate"],
        },
      ],
    },
  };
}

function installGatewayBehavior(params?: {
  firstSnapshot?: ReturnType<typeof snapshotPayload>;
  freshSnapshot?: ReturnType<typeof snapshotPayload> | Error;
  outcome?: { code: string; message?: string | null };
}) {
  let observeCalls = 0;
  callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
    const command = (body as { command?: string }).command;
    if (command === OBSERVE) {
      observeCalls += 1;
      if (observeCalls > 1 && params?.freshSnapshot instanceof Error) {
        throw params.freshSnapshot;
      }
      return observeCalls === 1
        ? (params?.firstSnapshot ?? snapshotPayload())
        : (params?.freshSnapshot ?? snapshotPayload({ id: "snapshot-2" }));
    }
    if (command === ACT) {
      return { payload: params?.outcome ?? { code: "completed", message: null } };
    }
    throw new Error(`unexpected command: ${command}`);
  });
}

function invokeBodies(command: string) {
  return callGatewayToolMock.mock.calls
    .map((call) => call[2] as Record<string, unknown>)
    .filter((body) => body.command === command);
}

async function observedTool(params: Parameters<typeof installGatewayBehavior>[0] = {}) {
  installGatewayBehavior(params);
  const tool = createMobileUiTool({ idempotencyScope: "run-1" });
  await observe(tool);
  return tool;
}

const activation = {
  action: "act",
  snapshotId: "snapshot-1",
  mobileAction: { type: "activate", ref: "n1" },
};

beforeEach(() => {
  listNodesMock.mockReset();
  callGatewayToolMock.mockReset();
  listNodesMock.mockResolvedValue([androidMobileUiNode()]);
});

it("selects the connected Android node advertising mobileUI", async () => {
  listNodesMock.mockResolvedValue([
    androidMobileUiNode({ nodeId: "android-ineligible", caps: [] }),
    androidMobileUiNode({ nodeId: "android-ready" }),
    androidMobileUiNode({ nodeId: "mac-1", platform: "macos" }),
  ]);
  installGatewayBehavior();

  await observe();

  expect(invokeBodies(OBSERVE)[0]).toMatchObject({ nodeId: "android-ready", params: {} });
});

it("keeps queued calls ordered after a failed observation", async () => {
  const started = createDeferredCore();
  const release = createDeferredCore();
  const failure = new Error("node disconnected");
  listNodesMock.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    throw failure;
  });
  installGatewayBehavior();
  const tool = createMobileUiTool();
  const failed = expect(tool.execute("first", { action: "observe" })).rejects.toBe(failure);
  await started.promise;
  const next = tool.execute("second", { action: "observe" });
  expect(listNodesMock).toHaveBeenCalledOnce();
  release.resolve();
  await failed;
  await expect(next).resolves.toMatchObject({ details: { snapshotId: "snapshot-1" } });
});

it.each([
  {
    name: "an explicit ineligible id",
    nodes: [
      androidMobileUiNode({ nodeId: "android-disabled", caps: [] }),
      androidMobileUiNode({ nodeId: "android-ready" }),
    ],
    node: "android-disabled",
    error:
      /node "android-disabled" is not a mobile-UI-capable device.*eligible device ids: android-ready/,
  },
  {
    name: "an ambiguous display name",
    nodes: ["android-a", "android-b"].map((nodeId) =>
      androidMobileUiNode({ nodeId, displayName: "Shared Pixel" }),
    ),
    node: "Shared Pixel",
    error:
      /ambiguous node: Shared Pixel.*node=android-a.*node=android-b.*eligible mobile-UI device ids: android-a, android-b/,
  },
  {
    name: "no eligible Android device",
    nodes: [
      androidMobileUiNode({ connected: false }),
      androidMobileUiNode({ nodeId: "no-cap", caps: [] }),
    ],
    node: undefined,
    error: /no mobile-UI-capable device paired and enabled/,
  },
])("rejects $name without invoking the Gateway", async ({ nodes, node, error }) => {
  listNodesMock.mockResolvedValue(nodes);
  await expect(observe(createMobileUiTool(), { node })).rejects.toThrow(error);
  expect(callGatewayToolMock).not.toHaveBeenCalled();
});

it("rejects swipes longer than Android's gesture-duration limit", async () => {
  const tool = await observedTool();

  await expect(
    act(tool, {
      mobileAction: { type: "swipe", x1: 0, y1: 0, x2: 100, y2: 100, durationMs: 60_001 },
    }),
  ).rejects.toThrow(/durationMs must be an integer between 1 and 60000/);
  expect(invokeBodies(ACT)).toHaveLength(0);
});

it("gives long actions headroom in both gateway and node timeouts", async () => {
  const tool = await observedTool();

  await act(tool, {
    mobileAction: { type: "wait", ms: 100_000 },
    timeoutMs: 60_000,
  });

  const actCall = callGatewayToolMock.mock.calls.find(
    (call) => (call[2] as { command?: string }).command === ACT,
  );
  expect(actCall?.[1]).toMatchObject({ timeoutMs: 110_000 });
  expect(actCall?.[2]).toMatchObject({ timeoutMs: 110_000 });
});

it("surfaces target_stale and requires use of the fresh snapshot", async () => {
  const code = "target_stale";
  const tool = await observedTool({ outcome: { code, message: "Observe again" } });

  const result = await act(tool, { confirmed: true });

  expect(result.details).toMatchObject({
    outcome: { code, message: "Observe again" },
    requiresReobserve: true,
    instruction: expect.stringMatching(/fresh snapshot/),
    snapshot: { snapshotId: "snapshot-2" },
  });
});

it("preserves a completed act outcome when postcondition observation fails", async () => {
  const tool = await observedTool({
    freshSnapshot: new Error("accessibility service disconnected"),
  });

  const result = await act(tool, { confirmed: true });

  expect(result.details).toEqual({
    outcome: { code: "completed", message: null },
    requiresReobserve: true,
    postconditionVerification: {
      code: "observe_failed",
      message: "accessibility service disconnected",
    },
  });
  await expect(act(tool, { confirmed: true }, "act-2")).rejects.toThrow(
    /observe again before acting/,
  );
  expect(invokeBodies(ACT)).toHaveLength(1);
});

it.each<[string, RegExp]>([
  [
    'node command not allowed: "mobile.ui.observe" is not in the allowlist for platform "android"',
    /enable Android Accessibility Control.*approve the pairing update/i,
  ],
  [
    'node command not allowed: "mobile.ui.observe" is blocked by gateway.nodes.commands.deny',
    /remove the mobile UI commands from gateway\.nodes\.commands\.deny/,
  ],
])("adds remediation for %s", async (message, remediation) => {
  callGatewayToolMock.mockRejectedValue(new Error(message));
  await expect(observe()).rejects.toThrow(remediation);
});

it("uses keyword matches only to enrich a required confirmation", async () => {
  const tool = await observedTool({
    firstSnapshot: snapshotPayload({ packageName: "com.example.messages", text: "Send message" }),
  });

  const result = await act(tool);

  expect(result.details).toEqual({
    code: "confirmation_required",
    package: "com.example.messages",
    target: "Send message",
    proposedEffect: "send, share, publish, or submit information",
  });
  expect(invokeBodies(ACT)).toHaveLength(0);
});

it.each([
  [activation.mobileAction, "Next"],
  [{ type: "set_text", ref: "n1", text: "hello" }, "Next"],
  [{ type: "tap", x: 25, y: 35 }, "coordinates (25, 35)"],
  [{ type: "swipe", x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 500 }, "coordinates (1, 2) to (3, 4)"],
] as const)("requires confirmation for %j before dispatch", async (mobileAction, target) => {
  const tool = await observedTool();
  expect((await act(tool, { mobileAction }, "unconfirmed")).details).toEqual({
    code: "confirmation_required",
    package: "example.app",
    target,
    proposedEffect: `perform a state-changing action (${mobileAction.type}) on example.app targeting ${target}`,
  });
  expect(invokeBodies(ACT)).toHaveLength(0);
  await expect(act(tool, { mobileAction, confirmed: true }, "confirmed")).resolves.toMatchObject({
    details: { outcome: { code: "completed" } },
  });
  expect(invokeBodies(ACT)).toHaveLength(1);
  expect(invokeBodies(ACT)[0]?.idempotencyKey).toMatch(/^mobile\.ui\.act:v2:[0-9a-f]{64}$/);
});

it.each([
  ["scroll", { type: "scroll", ref: "n1", direction: "forward" }],
  ["wait", { type: "wait", ms: 0 }],
  ["global navigation", { type: "global_action", name: "home" }],
])("does not require confirmation for %s", async (_label, mobileAction) => {
  const tool = await observedTool();

  await expect(act(tool, { mobileAction })).resolves.toMatchObject({
    details: { outcome: { code: "completed" } },
  });
  expect(invokeBodies(ACT)).toHaveLength(1);
});
