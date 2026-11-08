import { assert, vi } from "vitest";
import type {
  ComputerUseCapabilityDescriptor,
  ComputerUseV2ActionName,
} from "../../plugins/computer-use-contract.js";

const mocks = vi.hoisted(() => ({
  listNodesMock: vi.fn(),
  callGatewayToolMock: vi.fn(),
  sleepMock: vi.fn(),
  gatewayComputerStatusMock: vi.fn(),
}));
export const { listNodesMock, callGatewayToolMock, sleepMock, gatewayComputerStatusMock } = mocks;

export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
export const COMPUTER_ACT_COMMAND = "computer.act";

vi.mock("./nodes-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./nodes-utils.js")>()),
  listNodes: listNodesMock,
}));

vi.mock("./gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway.js")>()),
  callGatewayTool: callGatewayToolMock,
}));

vi.mock("../../utils/sleep.js", () => ({ sleep: sleepMock }));
vi.mock("./computer-tool-gateway.js", () => ({
  loadGatewayComputerStatus: gatewayComputerStatusMock,
  bindGatewayComputerCleanup: async () => undefined,
}));

export const { createComputerTool, invalidateComputerFrameIfMissing } =
  await import("./computer-tool.js");
export const { loadPairedComputerUseAvailabilityForSurface } =
  await import("../computer-use-node-capabilities.js");
const { DEFAULT_IMAGE_MAX_DIMENSION_PX } = await import("../image-sanitization.js");

// With no config the reference width is capped at the default sanitization limit.
export const EFFECTIVE_REF_WIDTH = Math.min(1280, DEFAULT_IMAGE_MAX_DIMENSION_PX);

export const macComputerNode = (overrides?: Record<string, unknown>) => ({
  nodeId: "mac-1",
  displayName: "Studio",
  platform: "macos",
  connected: true,
  commands: ["screen.snapshot", "computer.act"],
  ...overrides,
});

export function v2Descriptor(
  actions: ComputerUseV2ActionName[],
  overrides: Partial<ComputerUseCapabilityDescriptor> = {},
): ComputerUseCapabilityDescriptor {
  return {
    contractVersion: 2 as const,
    provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
    actions,
    targets: ["screen", "window", "element", "browser"] as const,
    deliveryModes: ["background", "foreground"] as const,
    observations: ["image", "accessibility", "browser"] as const,
    features: { recording: false, agentCursor: false, multiDisplay: false },
    ...overrides,
  };
}

export type ComputerTool = ReturnType<typeof createComputerTool>;
export type ComputerToolOptions = NonNullable<Parameters<typeof createComputerTool>[0]>;
export type ComputerActBody = {
  nodeId?: string;
  command?: string;
  idempotencyKey?: string;
  params?: Record<string, unknown>;
};

export function readActionEnum(tool: ComputerTool): string[] {
  const schema = tool.parameters as { properties?: { action?: { enum?: string[] } } };
  return schema.properties?.action?.enum ?? [];
}

export const screenshotPayload = (screenIndex = 0, base64 = TINY_PNG_BASE64) => ({
  payload: {
    format: "png",
    base64,
    displayFrameId: `display-${screenIndex}-frame`,
    width: 1280,
    height: 800,
    screenIndex,
  },
});

export function readFrameId(result: { details?: unknown }): string {
  const frameId = (result.details as { frameId?: unknown } | undefined)?.frameId;
  assert(typeof frameId === "string", "missing frameId");
  return frameId;
}

export function readLastComputerActParams(
  action?: ComputerUseV2ActionName,
): Record<string, unknown> {
  const call = callGatewayToolMock.mock.calls.findLast((entry) => {
    const body = entry[2] as ComputerActBody;
    return body.command === COMPUTER_ACT_COMMAND && (!action || body.params?.action === action);
  });
  const body = call?.[2] as { params?: Record<string, unknown> } | undefined;
  assert(body?.params, "missing computer.act request");
  const { executionId: _executionId, ...params } = body.params;
  return params;
}

export { createComputerTool as createVisionComputerTool };

export function resetComputerToolMocks() {
  listNodesMock.mockReset().mockResolvedValue([macComputerNode()]);
  callGatewayToolMock.mockReset();
  gatewayComputerStatusMock.mockReset().mockResolvedValue({ configured: false, available: false });
  sleepMock.mockReset().mockImplementation((ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) {
      return Promise.reject(new Error("Aborted"));
    }
    if (ms === 500 || !signal) {
      return Promise.resolve();
    }
    return new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    });
  });
  callGatewayToolMock.mockImplementation(async (_method, _opts, body) =>
    (body as ComputerActBody).command === COMPUTER_ACT_COMMAND
      ? { payload: { ok: true } }
      : screenshotPayload(),
  );
}
