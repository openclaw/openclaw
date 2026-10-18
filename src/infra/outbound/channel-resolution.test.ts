import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  workspace: vi.fn(),
  loaded: vi.fn(),
  bundled: vi.fn(),
  autoEnable: vi.fn(),
  discover: vi.fn(),
  load: vi.fn(),
  active: vi.fn(),
  version: vi.fn(),
  normalize: vi.fn(),
  deliverable: vi.fn(),
}));
vi.mock("../../agents/agent-scope.js", () => ({
  tryResolveAmbientOwnerAgentId: mocks.owner,
  resolveAgentWorkspaceDir: mocks.workspace,
}));
vi.mock("../../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: mocks.loaded,
  getChannelPlugin: mocks.bundled,
}));
vi.mock("../../config/plugin-auto-enable.js", () => ({ applyPluginAutoEnable: mocks.autoEnable }));
vi.mock("../../plugins/channel-plugin-ids.js", () => ({
  resolveDiscoverableScopedChannelPluginIds: mocks.discover,
}));
vi.mock("../../plugins/loader.js", () => ({ loadPluginRegistryHandle: mocks.load }));
vi.mock("../../plugins/plugin-metadata-state-worker.js", () => ({
  readPluginMetadataStateRow: vi.fn(async () => undefined),
}));
vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: mocks.active,
  getActivePluginRegistryVersion: mocks.version,
}));
vi.mock("../../utils/message-channel.js", () => ({
  INTERNAL_MESSAGE_CHANNEL: "webchat",
  normalizeMessageChannel: mocks.normalize,
  isDeliverableMessageChannel: mocks.deliverable,
}));

let resolution: typeof import("./channel-resolution.js");
let withScope: typeof import("../../plugins/runtime/gateway-request-scope.js").withPluginRuntimeRegistryScope;
beforeAll(async () => {
  vi.resetModules();
  ({ withPluginRuntimeRegistryScope: withScope } =
    await import("../../plugins/runtime/gateway-request-scope.js"));
  resolution = await import("./channel-resolution.js");
});
beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.normalize.mockImplementation((value?: string | null) =>
    typeof value === "string" ? value.trim().toLowerCase() : undefined,
  );
  mocks.deliverable.mockImplementation((value?: string) =>
    ["alpha", "beta", "gamma"].includes(String(value)),
  );
  mocks.active.mockReturnValue({ channels: [] });
  mocks.version.mockReturnValue(1);
  mocks.autoEnable.mockReturnValue({ config: { autoEnabled: true }, autoEnabledReasons: {} });
  mocks.discover.mockReturnValue(["alpha-plugin"]);
  mocks.load.mockReturnValue({ channels: [] });
  mocks.owner.mockReturnValue("main");
  mocks.workspace.mockReturnValue("/tmp/workspace");
});

function params(channel: string, allowBootstrap?: true) {
  return { channel, cfg: { channels: {} }, ...(allowBootstrap ? { allowBootstrap } : {}) };
}
function resolvePlugin(channel: string, bootstrap?: true) {
  return resolution.resolveOutboundChannelPlugin(params(channel, bootstrap));
}
function resolveMessage(channel: string, bootstrap?: true) {
  return resolution.resolveOutboundChannelMessageAdapter(params(channel, bootstrap));
}

describe("outbound channel resolution", () => {
  it.each([
    { input: " Alpha ", expected: "alpha" },
    { input: "unknown", expected: undefined },
  ])("normalizes deliverable outbound channel for %j", ({ input, expected }) => {
    expect(resolution.normalizeDeliverableOutboundChannel(input)).toBe(expected);
  });

  it("does not borrow a loaded message adapter from a scoped outbound-only registration", async () => {
    mocks.loaded.mockReturnValue({ id: "alpha", message: { send: { text: vi.fn() } } });
    const scoped = {
      ...createChannelTestPluginBase({ id: "alpha" }),
      outbound: { deliveryMode: "direct" as const, sendText: vi.fn() },
    };
    const registry = createTestRegistry([{ pluginId: "scoped", plugin: scoped, source: "test" }]);
    await withScope(registry, async () => {
      expect(resolution.resolveOutboundChannelPlugin({ channel: "alpha" })).toBe(scoped);
      expect(
        await resolution.resolveOutboundChannelMessageAdapter({ channel: "alpha" }),
      ).toBeUndefined();
    });
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("keeps a bootstrapped external alias available to normal runtime lookups", async () => {
    const message = { send: { text: vi.fn() } };
    const plugin = { id: "external-channel", meta: { aliases: ["external"] }, message };
    mocks.deliverable.mockReturnValue(false);
    mocks.active.mockImplementation(() =>
      mocks.load.mock.calls.length > 0 ? { channels: [{ plugin }] } : null,
    );
    expect(resolvePlugin("external", true)).toBe(plugin);
    expect(resolvePlugin("external")).toBe(plugin);
    expect(await resolveMessage("external")).toBe(message);
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });

  it("bootstraps instead of returning direct outbound metadata from a setup shell", () => {
    const setup = { id: "alpha", outbound: { deliveryMode: "direct" } };
    const runtime = { id: "alpha", outbound: { deliveryMode: "direct", sendText: vi.fn() } };
    mocks.loaded.mockReturnValue(setup);
    mocks.active.mockImplementation(() => ({
      channels: [{ plugin: mocks.load.mock.calls.length > 0 ? runtime : setup }],
    }));
    expect(resolvePlugin("alpha", true)).toBe(runtime);
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });

  it("bootstraps an external channel before resolving its message adapter", async () => {
    const message = { send: { text: vi.fn() } };
    const plugin = { id: "external-channel", message };
    mocks.deliverable.mockImplementation(
      (value?: string) => value === "external-channel" && mocks.load.mock.calls.length > 0,
    );
    mocks.loaded.mockImplementation(() => (mocks.load.mock.calls.length > 0 ? plugin : undefined));
    expect(await resolveMessage("external-channel", true)).toBe(message);
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });

  it("does not bootstrap by default for outbound hot-path resolution", () => {
    const plugin = { id: "alpha" };
    mocks.bundled.mockReturnValue(plugin);
    expect(resolvePlugin("alpha")).toBe(plugin);
    expect(mocks.load).not.toHaveBeenCalled();
  });
});
