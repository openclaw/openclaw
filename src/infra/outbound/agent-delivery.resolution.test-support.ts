import { vi } from "vitest";

export const mocks = vi.hoisted(() => ({
  resolveOutboundChannelPlugin: vi.fn<() => unknown>(),
  resolveChannelTarget: vi.fn<(params: { input: string }) => Promise<unknown>>(),
  resolveOutboundTarget: vi.fn<() => { ok: true; to: string } | { ok: false; error: Error }>(),
  resolveOutboundSessionRoute: vi.fn<() => Promise<unknown>>(),
  resolveSessionDeliveryTarget: vi.fn<
    (params: { requestedChannel?: string; explicitTo?: string }) => {
      channel?: string;
      to?: string;
      mode: string;
    }
  >(),
}));
const channels = vi.hoisted(() => ({ selected: "", internalGateway: false }));

vi.mock("./targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
  resolveSessionDeliveryTarget: mocks.resolveSessionDeliveryTarget,
}));
vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));
vi.mock("./outbound-session.js", () => ({
  resolveOutboundSessionRoute: mocks.resolveOutboundSessionRoute,
}));
vi.mock("./target-resolver.js", () => ({ resolveChannelTarget: mocks.resolveChannelTarget }));
vi.mock("../../utils/message-channel.js", () => ({
  INTERNAL_MESSAGE_CHANNEL: "webchat",
  isDeliverableMessageChannel: (channel: string) => channel === channels.selected,
  isGatewayMessageChannel: (channel: string) =>
    channel === channels.selected || (channels.internalGateway && channel === "webchat"),
  normalizeMessageChannel: (value: string) => value.trim().toLowerCase(),
}));

export function resetResolutionMocks(selected: string, internalGateway = false) {
  Object.assign(channels, { selected, internalGateway });
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
}
