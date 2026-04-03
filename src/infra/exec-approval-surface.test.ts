import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());
const listChannelPluginsMock = vi.hoisted(() => vi.fn());
const isDeliverableMessageChannelMock = vi.hoisted(() => vi.fn());
const normalizeMessageChannelMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: (...args: unknown[]) => loadConfigMock(...args),
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

type ExecApprovalSurfaceModule = typeof import("./exec-approval-surface.js");

let hasConfiguredExecApprovalDmRoute: ExecApprovalSurfaceModule["hasConfiguredExecApprovalDmRoute"];
let resolveExecApprovalInitiatingSurfaceState: ExecApprovalSurfaceModule["resolveExecApprovalInitiatingSurfaceState"];

describe("resolveExecApprovalInitiatingSurfaceState", () => {
  beforeAll(async () => {
    ({ hasConfiguredExecApprovalDmRoute, resolveExecApprovalInitiatingSurfaceState } =
      await import("./exec-approval-surface.js"));
  });

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
    {
      channel: null,
      expected: {
        kind: "enabled",
        channel: undefined,
        channelLabel: "this platform",
      },
    },
    {
      channel: "tui",
      expected: {
        kind: "enabled",
        channel: "tui",
        channelLabel: "terminal UI",
      },
    },
    {
      channel: "web",
      expected: {
        kind: "enabled",
        channel: "web",
        channelLabel: "Web UI",
      },
    },
  ])("treats built-in initiating surface %j", ({ channel, expected }) => {
    expect(resolveExecApprovalInitiatingSurfaceState({ channel })).toEqual(expected);
  });

  it("uses the provided cfg for telegram and discord client enablement", () => {
    getChannelPluginMock.mockImplementation((channel: string) =>
      channel === "telegram"
        ? {
            auth: {
              getActionAvailabilityState: () => ({ kind: "enabled" }),
            },
          }
        : channel === "discord"
          ? {
              auth: {
                getActionAvailabilityState: () => ({ kind: "disabled" }),
              },
            }
          : undefined,
    );
    const cfg = { channels: {} };

    expect(
      resolveExecApprovalInitiatingSurfaceState({
        channel: "telegram",
        accountId: "main",
        cfg: cfg as never,
      }),
    ).toEqual({
      kind: "enabled",
      channel: "telegram",
      channelLabel: "Telegram",
    });
    expect(
      resolveExecApprovalInitiatingSurfaceState({
        channel: "discord",
        accountId: "main",
        cfg: cfg as never,
      }),
    ).toEqual({
      kind: "disabled",
      channel: "discord",
      channelLabel: "Discord",
    });

    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("reads approval availability from approvalCapability when auth is omitted", () => {
    getChannelPluginMock.mockReturnValue({
      approvalCapability: {
        getActionAvailabilityState: () => ({ kind: "disabled" }),
      },
    });

    expect(
      resolveExecApprovalInitiatingSurfaceState({
        channel: "discord",
        accountId: "main",
        cfg: {} as never,
      }),
    ).toEqual({
      kind: "disabled",
      channel: "discord",
      channelLabel: "Discord",
    });
  });

  it("loads config lazily when cfg is omitted and marks unsupported channels", () => {
    loadConfigMock.mockReturnValueOnce({ loaded: true });
    getChannelPluginMock.mockImplementation((channel: string) =>
      channel === "telegram"
        ? {
            auth: {
              getActionAvailabilityState: () => ({ kind: "disabled" }),
            },
          }
        : undefined,
    );

    expect(
      resolveExecApprovalInitiatingSurfaceState({
        channel: "telegram",
        accountId: "main",
      }),
    ).toEqual({
      kind: "disabled",
      channel: "telegram",
      channelLabel: "Telegram",
    });
    expect(loadConfigMock).toHaveBeenCalledOnce();

    expect(resolveExecApprovalInitiatingSurfaceState({ channel: "signal" })).toEqual({
      kind: "unsupported",
      channel: "signal",
      channelLabel: "Signal",
    });
  });

  it("treats deliverable chat channels without a custom adapter as enabled", () => {
    expect(resolveExecApprovalInitiatingSurfaceState({ channel: "slack" })).toEqual({
      kind: "enabled",
      channel: "slack",
      channelLabel: "Slack",
    });
  });
});

describe("hasConfiguredExecApprovalDmRoute", () => {
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
    {
      plugins: [
        {
          approvals: {
            delivery: {
              hasConfiguredDmRoute: () => false,
            },
          },
        },
        {
          approvals: {
            delivery: {
              hasConfiguredDmRoute: () => true,
            },
          },
        },
      ],
      expected: true,
    },
    {
      plugins: [
        {
          approvals: {
            delivery: {
              hasConfiguredDmRoute: () => false,
            },
          },
        },
        {
          approvals: {
            delivery: {
              hasConfiguredDmRoute: () => false,
            },
          },
        },
        {
          approvals: undefined,
        },
      ],
      expected: false,
    },
  ])("reports whether any plugin routes approvals to DM for %j", ({ plugins, expected }) => {
    listChannelPluginsMock.mockReturnValueOnce(plugins);
    expect(hasConfiguredExecApprovalDmRoute({} as never)).toBe(expected);
  });

  it("detects DM routes exposed through approvalCapability", () => {
    listChannelPluginsMock.mockReturnValueOnce([
      {
        approvalCapability: {
          delivery: {
            hasConfiguredDmRoute: () => true,
          },
        },
      },
    ]);

    expect(hasConfiguredExecApprovalDmRoute({} as never)).toBe(true);
  });

  it("preserves legacy DM routes when approvalCapability only defines auth", () => {
    listChannelPluginsMock.mockReturnValueOnce([
      {
        approvalCapability: {
          authorizeActorAction: () => ({ authorized: true }),
        },
        approvals: {
          delivery: {
            hasConfiguredDmRoute: () => true,
          },
        },
      },
    ]);

    expect(hasConfiguredExecApprovalDmRoute({} as never)).toBe(true);
  });
});
