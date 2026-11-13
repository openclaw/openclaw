import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelApprovalKind } from "./approval-types.js";
import {
  describeNativeExecApprovalClientSetup as execSetup,
  describeNativePluginApprovalClientSetup as pluginSetup,
  resolveApprovalInitiatingSurfaceStateAsync as resolveApproval,
  resolveExecApprovalInitiatingSurfaceStateAsync as resolveExec,
  supportsNativeExecApprovalClient,
} from "./exec-approval-surface.js";

const loadConfigMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());
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

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: (...args: unknown[]) => loadConfigMock(...args),
}));

vi.mock("../channels/plugins/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/plugins/index.js")>()),
  getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
}));

describe("resolveExecApprovalInitiatingSurfaceStateAsync", () => {
  beforeEach(() => {
    loadConfigMock.mockReset().mockReturnValue({});
    getChannelPluginMock.mockReset();
  });

  it.each([
    [null, "this platform"],
    ["tui", "terminal UI"],
    ["webchat", "Web UI"],
  ] as const)("treats built-in initiating surface %j", async (channel, label) => {
    expect(await resolveExec({ channel })).toEqual(surface("enabled", channel ?? undefined, label));
  });

  it.each([
    ["exec", "matrix", "Matrix"],
    ["plugin", "whatsapp", "WhatsApp"],
  ] as const)("selects the %s availability owner", async (approvalKind, channel, label) => {
    const request = {
      id: "plugin:calendar",
      request: { title: "Review", description: "Tool", policySubject: { pluginKey: "calendar" } },
      createdAtMs: 0,
      expiresAtMs: 1,
    };
    const getExecInitiatingSurfaceState = vi.fn(() => ({
      kind: approvalKind === "exec" ? ("disabled" as const) : ("enabled" as const),
    }));
    const getActionAvailabilityState = vi.fn(
      ({ approvalKind: kind }: { approvalKind?: ChannelApprovalKind }) =>
        kind === "plugin" ? { kind: "disabled" as const } : { kind: "enabled" as const },
    );
    if (approvalKind === "exec") {
      plugin(label, { native: {}, getExecInitiatingSurfaceState });
      expect(supportsNativeExecApprovalClient(channel)).toBe(true);
    }
    plugin(label, { native: {}, getExecInitiatingSurfaceState, getActionAvailabilityState });
    const params = { channel, accountId: "default" };
    const result =
      approvalKind === "exec"
        ? await resolveExec(params)
        : await resolveApproval({ ...params, approvalKind, request });
    expect(result).toEqual(surface("disabled", channel, label, "default"));
    const [called, unused] =
      approvalKind === "exec"
        ? [getExecInitiatingSurfaceState, getActionAvailabilityState]
        : [getActionAvailabilityState, getExecInitiatingSurfaceState];
    expect(called).toHaveBeenCalledWith({
      cfg: {},
      accountId: "default",
      action: "approve",
      ...(approvalKind === "plugin" ? { approvalKind, request } : {}),
    });
    expect(unused).not.toHaveBeenCalled();
  });

  it("awaits native availability instead of selecting a synchronous fallback", async () => {
    const availability = Promise.withResolvers<{ kind: "disabled" }>();
    const syncFallback = vi.fn(() => ({ kind: "enabled" as const }));
    plugin("Matrix", {
      nativeAsync: {},
      getExecInitiatingSurfaceStateAsync: () => availability.promise,
      getExecInitiatingSurfaceState: syncFallback,
      getActionAvailabilityState: syncFallback,
    });

    const result = resolveExec({
      channel: "matrix",
      accountId: "default",
    });
    expect(supportsNativeExecApprovalClient("matrix")).toBe(true);
    availability.resolve({ kind: "disabled" });
    await expect(result).resolves.toEqual(surface("disabled", "matrix", "Matrix", "default"));
    expect(syncFallback).not.toHaveBeenCalled();
  });

  it("reports no plugin approval route when the channel cannot enforce scoped reviewers", async () => {
    const getActionAvailabilityState = vi.fn(() => ({ kind: "enabled" as const }));
    plugin("Slack", { getActionAvailabilityState });
    const cfg = {
      approvals: { plugin: { slack: { approvers: ["team:T11111111:user:U11111111"] } } },
    } as never;

    expect(
      await resolveApproval({
        channel: "slack",
        cfg,
        approvalKind: "plugin",
      }),
    ).toMatchObject({ kind: "disabled", channel: "slack" });
    expect(getActionAvailabilityState).not.toHaveBeenCalled();
  });

  it("loads config lazily when cfg is omitted and marks unsupported channels", async () => {
    loadConfigMock.mockReturnValueOnce({ loaded: true });
    const approvalCapability = {
      getActionAvailabilityState: ({ approvalKind }: { approvalKind?: ChannelApprovalKind }) => ({
        kind: approvalKind === "plugin" ? "enabled" : "disabled",
      }),
    };
    getChannelPluginMock.mockImplementation((channel: string) =>
      channel === "telegram" ? { meta: { label: "Telegram" }, approvalCapability } : undefined,
    );

    expect(
      await resolveExec({
        channel: "telegram",
        accountId: "main",
      }),
    ).toEqual(surface("disabled", "telegram", "Telegram", "main"));
    expect(loadConfigMock).toHaveBeenCalledOnce();
    expect(await resolveExec({ channel: "unsupported-channel" })).toEqual(
      surface("unsupported", "unsupported-channel", "Unsupported-channel"),
    );
  });

  it("treats deliverable chat channels without a custom adapter as enabled", async () => {
    expect(await resolveExec({ channel: "slack" })).toEqual(surface("enabled", "slack", "Slack"));
  });

  it.each([
    [execSetup, "describeExecApprovalSetup", "describePluginApprovalSetup"],
    [pluginSetup, "describePluginApprovalSetup", "describeExecApprovalSetup"],
  ] as const)(
    "normalizes setup through %s without using its sibling or internal UI",
    (setup, key, sibling) => {
      const selected = vi.fn(() => "selected setup");
      const unused = vi.fn(() => "sibling setup");
      plugin("Telegram", { [key]: selected, [sibling]: unused });
      expect(
        setup({ channel: " Telegram ", channelLabel: " Telegram Custom ", accountId: " primary " }),
      ).toBe("selected setup");
      expect(selected).toHaveBeenCalledWith({
        channel: "telegram",
        channelLabel: "Telegram Custom",
        accountId: "primary",
      });
      expect(setup({ channel: " TELEGRAM " })).toBe("selected setup");
      expect(selected).toHaveBeenCalledWith({
        channel: "telegram",
        channelLabel: "Telegram",
        accountId: undefined,
      });
      expect(unused).not.toHaveBeenCalled();
      plugin("Telegram", { [sibling]: unused });
      expect(setup({ channel: "telegram" })).toBeNull();
      expect(unused).not.toHaveBeenCalled();
      getChannelPluginMock.mockClear();
      expect(setup({ channel: "tui" })).toBeNull();
      expect(getChannelPluginMock).not.toHaveBeenCalled();
    },
  );
});
