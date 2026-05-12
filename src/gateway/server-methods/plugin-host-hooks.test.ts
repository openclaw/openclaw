import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  getActivePluginRegistry: vi.fn(),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: mocks.getActivePluginRegistry,
}));

import { pluginHostHookHandlers } from "./plugin-host-hooks.js";

type DescriptorRow = {
  pluginId: string;
  pluginName?: string;
  descriptor: Record<string, unknown>;
  source: string;
};

function createOptions(
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method: "plugins.uiDescriptors", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {},
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

function getRespondResult(respond: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = respond.mock.calls.at(0);
  if (!call) {
    throw new Error("expected respond call");
  }
  const [ok, result] = call;
  expect(ok).toBe(true);
  if (!result || typeof result !== "object") {
    throw new Error("expected respond result object");
  }
  return result as Record<string, unknown>;
}

function getDescriptors(respond: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  const result = getRespondResult(respond);
  expect(Array.isArray(result.descriptors)).toBe(true);
  return result.descriptors as Array<Record<string, unknown>>;
}

describe("plugins.uiDescriptors projection ordering", () => {
  beforeEach(() => {
    mocks.getActivePluginRegistry.mockReset();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns an empty list when no registry is active", async () => {
    mocks.getActivePluginRegistry.mockReturnValue(undefined);
    const options = createOptions({});
    const handler = pluginHostHookHandlers["plugins.uiDescriptors"];
    if (!handler) {
      throw new Error("handler missing");
    }
    await handler(options);
    expect(getDescriptors(options.respond as ReturnType<typeof vi.fn>)).toEqual([]);
  });

  it("sorts descriptors by priority ascending, with pluginId then descriptor id as tiebreakers", async () => {
    const rows: DescriptorRow[] = [
      {
        pluginId: "z-plugin",
        descriptor: { id: "card-1", surface: "chat-message", label: "Z-1", priority: 50 },
        source: "test",
      },
      {
        pluginId: "a-plugin",
        descriptor: { id: "card-1", surface: "chat-message", label: "A-1", priority: 10 },
        source: "test",
      },
      {
        pluginId: "a-plugin",
        descriptor: { id: "card-2", surface: "chat-message", label: "A-2", priority: 10 },
        source: "test",
      },
      {
        pluginId: "m-plugin",
        descriptor: { id: "no-priority", surface: "chat-input-toolbar-chip", label: "M-no" },
        source: "test",
      },
      {
        pluginId: "m-plugin",
        descriptor: { id: "negative", surface: "chat-message", label: "M-neg", priority: -5 },
        source: "test",
      },
    ];
    mocks.getActivePluginRegistry.mockReturnValue({ controlUiDescriptors: rows });

    const options = createOptions({});
    const handler = pluginHostHookHandlers["plugins.uiDescriptors"];
    if (!handler) {
      throw new Error("handler missing");
    }
    await handler(options);
    const descriptors = getDescriptors(options.respond as ReturnType<typeof vi.fn>);
    expect(
      descriptors.map((d) => ({
        pluginId: d.pluginId,
        id: d.id,
        priority: d.priority,
      })),
    ).toEqual([
      // negative priority renders first
      { pluginId: "m-plugin", id: "negative", priority: -5 },
      // priority 10 ties → break by pluginId asc, then by descriptor id asc
      { pluginId: "a-plugin", id: "card-1", priority: 10 },
      { pluginId: "a-plugin", id: "card-2", priority: 10 },
      // priority 50
      { pluginId: "z-plugin", id: "card-1", priority: 50 },
      // no priority sorts last (treated as +Infinity)
      { pluginId: "m-plugin", id: "no-priority", priority: undefined },
    ]);
  });

  it("preserves a deterministic order when all descriptors omit priority", async () => {
    const rows: DescriptorRow[] = [
      {
        pluginId: "beta",
        descriptor: { id: "x", surface: "session", label: "Beta-X" },
        source: "test",
      },
      {
        pluginId: "alpha",
        descriptor: { id: "y", surface: "session", label: "Alpha-Y" },
        source: "test",
      },
      {
        pluginId: "alpha",
        descriptor: { id: "x", surface: "session", label: "Alpha-X" },
        source: "test",
      },
    ];
    mocks.getActivePluginRegistry.mockReturnValue({ controlUiDescriptors: rows });

    const options = createOptions({});
    const handler = pluginHostHookHandlers["plugins.uiDescriptors"];
    if (!handler) {
      throw new Error("handler missing");
    }
    await handler(options);
    const descriptors = getDescriptors(options.respond as ReturnType<typeof vi.fn>);
    expect(descriptors.map((d) => `${d.pluginId}/${d.id}`)).toEqual([
      "alpha/x",
      "alpha/y",
      "beta/x",
    ]);
  });

  it("attaches pluginId and pluginName to each projected descriptor", async () => {
    const rows: DescriptorRow[] = [
      {
        pluginId: "plan-mode",
        pluginName: "Plan Mode",
        descriptor: {
          id: "plan-card",
          surface: "chat-message",
          label: "Plan card",
          priority: 10,
        },
        source: "test",
      },
    ];
    mocks.getActivePluginRegistry.mockReturnValue({ controlUiDescriptors: rows });

    const options = createOptions({});
    const handler = pluginHostHookHandlers["plugins.uiDescriptors"];
    if (!handler) {
      throw new Error("handler missing");
    }
    await handler(options);
    const [descriptor] = getDescriptors(options.respond as ReturnType<typeof vi.fn>);
    expect(descriptor).toMatchObject({
      pluginId: "plan-mode",
      pluginName: "Plan Mode",
      id: "plan-card",
      surface: "chat-message",
      label: "Plan card",
      priority: 10,
    });
  });
});
