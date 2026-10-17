// Covers approval initiating-surface detection.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelApprovalKind } from "./approval-types.js";
import {
  describeNativeExecApprovalClientSetup,
  describeNativePluginApprovalClientSetup,
  resolveApprovalInitiatingSurfaceStateAsync,
  resolveExecApprovalInitiatingSurfaceStateAsync,
  supportsNativeExecApprovalClient,
} from "./exec-approval-surface.js";

const loadConfigMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());
const listChannelPluginsMock = vi.hoisted(() => vi.fn());
const isDeliverableMessageChannelMock = vi.hoisted(() => vi.fn());
const normalizeMessageChannelMock = vi.hoisted(() => vi.fn());

function plugin(label: string, approvalCapability: Record<string, unknown>) {
  getChannelPluginMock.mockReturnValue({ meta: { label }, approvalCapability });
}

function surface(
  kind: string,
  channel: string | undefined,
  channelLabel: string,
  accountId?: string,
) {
  return { kind, channel, channelLabel, accountId };
}

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: (...args: unknown[]) => loadConfigMock(...args),
  };
});

vi.mock("../channels/plugins/index.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/index.js")>(
    "../channels/plugins/index.js",
  );
  return {
    ...actual,
    getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
    listChannelPlugins: (...args: unknown[]) => listChannelPluginsMock(...args),
  };
});

vi.mock("../utils/message-channel.js", () => ({
  INTERNAL_MESSAGE_CHANNEL: "web",
  isDeliverableMessageChannel: (...args: unknown[]) => isDeliverableMessageChannelMock(...args),
  normalizeMessageChannel: (...args: unknown[]) => normalizeMessageChannelMock(...args),
}));

describe("resolveExecApprovalInitiatingSurfaceStateAsync", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    getChannelPluginMock.mockReset();
    listChannelPluginsMock.mockReset();
    isDeliverableMessageChannelMock.mockReset();
    normalizeMessageChannelMock.mockReset();
    normalizeMessageChannelMock.mockImplementation((value?: string | null) =>
      typeof value === "string" ? value.trim().toLowerCase() : undefined,
    );
    isDeliverableMessageChannelMock.mockImplementation(
      (value?: string) => value === "slack" || value === "discord" || value === "telegram",
    );
  });

  it.each([
    [null, "this platform"],
    ["tui", "terminal UI"],
    ["web", "Web UI"],
  ] as const)("treats built-in initiating surface %j", async (channel, label) => {
    expect(await resolveExecApprovalInitiatingSurfaceStateAsync({ channel })).toEqual(
      surface("enabled", channel ?? undefined, label),
    );
  });

  it("prefers exec-initiating-surface state over generic approval availability", async () => {
    const getExecInitiatingSurfaceState = vi.fn(() => ({ kind: "disabled" as const }));
    const getActionAvailabilityState = vi.fn(() => ({ kind: "enabled" as const }));
    plugin("Matrix", {
      native: {},
      getExecInitiatingSurfaceState,
      getActionAvailabilityState,
    });

    expect(
      await resolveExecApprovalInitiatingSurfaceStateAsync({
        channel: "matrix",
        accountId: "default",
        cfg: {} as never,
      }),
    ).toEqual(surface("disabled", "matrix", "Matrix", "default"));
    expect(getExecInitiatingSurfaceState).toHaveBeenCalledWith({
      cfg: {} as never,
      accountId: "default",
      action: "approve",
    });
    expect(getActionAvailabilityState).not.toHaveBeenCalled();
  });

  it("uses generic approval availability for plugin initiating surfaces", async () => {
    const request = {
      id: "plugin:calendar",
      request: {
        title: "Review",
        description: "Calendar tool",
        policySubject: { pluginKey: "calendar" },
      },
      createdAtMs: 0,
      expiresAtMs: 1,
    };
    const getExecInitiatingSurfaceState = vi.fn(() => ({ kind: "enabled" as const }));
    const getActionAvailabilityState = vi.fn(
      ({ approvalKind }: { approvalKind?: ChannelApprovalKind }) =>
        approvalKind === "plugin" ? { kind: "disabled" as const } : { kind: "enabled" as const },
    );
    plugin("WhatsApp", {
      native: {},
      getExecInitiatingSurfaceState,
      getActionAvailabilityState,
    });

    expect(
      await resolveApprovalInitiatingSurfaceStateAsync({
        channel: "whatsapp",
        accountId: "default",
        cfg: {} as never,
        approvalKind: "plugin",
        request,
      }),
    ).toEqual(surface("disabled", "whatsapp", "WhatsApp", "default"));
    expect(getExecInitiatingSurfaceState).not.toHaveBeenCalled();
    expect(getActionAvailabilityState).toHaveBeenCalledWith({
      cfg: {} as never,
      accountId: "default",
      action: "approve",
      approvalKind: "plugin",
      request,
    });
  });

  it("awaits native availability instead of selecting a synchronous fallback", async () => {
    const availability = Promise.withResolvers<{ kind: "disabled" }>();
    const getExecInitiatingSurfaceState = vi.fn(() => ({ kind: "enabled" as const }));
    const getActionAvailabilityState = vi.fn(() => ({ kind: "enabled" as const }));
    plugin("Matrix", {
      nativeAsync: {},
      getExecInitiatingSurfaceStateAsync: () => availability.promise,
      getExecInitiatingSurfaceState,
      getActionAvailabilityState,
    });

    const result = resolveExecApprovalInitiatingSurfaceStateAsync({
      channel: "matrix",
      accountId: "default",
      cfg: {},
    });
    expect(supportsNativeExecApprovalClient("matrix")).toBe(true);
    availability.resolve({ kind: "disabled" });
    await expect(result).resolves.toEqual(surface("disabled", "matrix", "Matrix", "default"));
    expect(getExecInitiatingSurfaceState).not.toHaveBeenCalled();
    expect(getActionAvailabilityState).not.toHaveBeenCalled();
  });

  it("reports no plugin approval route when the channel cannot enforce scoped reviewers", async () => {
    const getActionAvailabilityState = vi.fn(() => ({ kind: "enabled" as const }));
    plugin("Slack", { getActionAvailabilityState });
    const cfg = {
      approvals: { plugin: { slack: { approvers: ["team:T11111111:user:U11111111"] } } },
    } as never;

    expect(
      await resolveApprovalInitiatingSurfaceStateAsync({
        channel: "slack",
        cfg,
        approvalKind: "plugin",
      }),
    ).toMatchObject({ kind: "disabled", channel: "slack" });
    expect(getActionAvailabilityState).not.toHaveBeenCalled();
  });

  it("loads config lazily when cfg is omitted and marks unsupported channels", async () => {
    loadConfigMock.mockReturnValueOnce({ loaded: true });
    getChannelPluginMock.mockImplementation((channel: string) =>
      channel === "telegram"
        ? {
            meta: { label: "Telegram" },
            approvalCapability: {
              getActionAvailabilityState: ({
                approvalKind,
              }: {
                approvalKind?: ChannelApprovalKind;
              }) =>
                approvalKind === "plugin"
                  ? { kind: "enabled" as const }
                  : { kind: "disabled" as const },
            },
          }
        : undefined,
    );

    expect(
      await resolveExecApprovalInitiatingSurfaceStateAsync({
        channel: "telegram",
        accountId: "main",
      }),
    ).toEqual(surface("disabled", "telegram", "Telegram", "main"));
    expect(loadConfigMock).toHaveBeenCalledOnce();

    expect(await resolveExecApprovalInitiatingSurfaceStateAsync({ channel: "signal" })).toEqual(
      surface("unsupported", "signal", "Signal"),
    );
  });

  it("treats deliverable chat channels without a custom adapter as enabled", async () => {
    expect(await resolveExecApprovalInitiatingSurfaceStateAsync({ channel: "slack" })).toEqual(
      surface("enabled", "slack", "Slack"),
    );
  });

  it("treats exec-specific initiating-surface hooks as native exec client support", () => {
    plugin("Matrix", {
      native: {},
      getExecInitiatingSurfaceState: () => ({ kind: "enabled" as const }),
    });

    expect(supportsNativeExecApprovalClient("matrix")).toBe(true);
  });

  it("routes normalized setup parameters to the selected approval hook", () => {
    const describeExecApprovalSetup = vi.fn(() => "exec setup");
    const describePluginApprovalSetup = vi.fn(() => "plugin setup");
    plugin("Telegram", { describeExecApprovalSetup, describePluginApprovalSetup });

    expect(
      describeNativeExecApprovalClientSetup({
        channel: " Telegram ",
        channelLabel: " Telegram Custom ",
        accountId: " primary ",
      }),
    ).toBe("exec setup");
    expect(describeExecApprovalSetup).toHaveBeenCalledWith({
      channel: "telegram",
      channelLabel: "Telegram Custom",
      accountId: "primary",
    });

    expect(describeNativePluginApprovalClientSetup({ channel: " TELEGRAM " })).toBe("plugin setup");
    expect(describePluginApprovalSetup).toHaveBeenCalledWith({
      channel: "telegram",
      channelLabel: "Telegram",
      accountId: undefined,
    });
  });

  it.each(["tui"])("suppresses setup guidance for %s", (channel) => {
    expect(describeNativeExecApprovalClientSetup({ channel })).toBeNull();
    expect(describeNativePluginApprovalClientSetup({ channel })).toBeNull();
    expect(getChannelPluginMock).not.toHaveBeenCalled();
  });

  it("does not fall back to the sibling approval hook", () => {
    const describeExecApprovalSetup = vi.fn(() => "exec setup");
    const describePluginApprovalSetup = vi.fn(() => "plugin setup");
    getChannelPluginMock.mockImplementation((channel: string) => ({
      meta: { label: channel },
      approvalCapability:
        channel === "telegram" ? { describePluginApprovalSetup } : { describeExecApprovalSetup },
    }));

    expect(describeNativeExecApprovalClientSetup({ channel: "telegram" })).toBeNull();
    expect(describePluginApprovalSetup).not.toHaveBeenCalled();
    expect(describeNativePluginApprovalClientSetup({ channel: "matrix" })).toBeNull();
    expect(describeExecApprovalSetup).not.toHaveBeenCalled();
  });
});
