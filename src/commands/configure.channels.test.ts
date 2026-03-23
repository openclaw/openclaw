import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  confirm: vi.fn(),
  note: vi.fn(),
  listChannelPlugins: vi.fn(),
  getChannelPlugin: vi.fn(),
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
  getChannelPlugin: mocks.getChannelPlugin,
}));

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "~/.openclaw/openclaw.json",
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

vi.mock("./configure.shared.js", () => ({
  confirm: mocks.confirm,
  select: mocks.select,
}));

vi.mock("./onboard-helpers.js", () => ({
  guardCancel: <T>(value: T) => value,
}));

import { removeChannelConfigWizard } from "./configure.channels.js";

describe("removeChannelConfigWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes a channel through plugin deleteAccount in non-default-first order", async () => {
    const deleteAccount = vi
      .fn()
      .mockImplementationOnce(({ cfg }: { cfg: OpenClawConfig; accountId: string }) => ({
        ...cfg,
        channels: {
          whatsapp: {
            enabled: true,
          },
        },
      }))
      .mockImplementationOnce(() => ({}) as OpenClawConfig);
    const onAccountRemoved = vi.fn(async () => {});
    const plugin = {
      meta: { id: "whatsapp", label: "WhatsApp" },
      config: {
        listAccountIds: vi.fn(() => ["default", "work"]),
        deleteAccount,
      },
      lifecycle: {
        onAccountRemoved,
      },
    };

    mocks.listChannelPlugins.mockReturnValue([plugin]);
    mocks.getChannelPlugin.mockReturnValue(plugin);
    mocks.select.mockResolvedValueOnce("whatsapp").mockResolvedValueOnce("done");
    mocks.confirm.mockResolvedValue(true);

    const result = await removeChannelConfigWizard(
      {
        channels: {
          whatsapp: {
            enabled: true,
            accounts: {
              work: { enabled: true },
            },
          },
        },
      } as OpenClawConfig,
      {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      } as never,
    );

    expect(
      deleteAccount.mock.calls.map((call) => (call[0] as { accountId: string }).accountId),
    ).toEqual(["work", "default"]);
    expect(
      onAccountRemoved.mock.calls.map(
        (call) =>
          (
            (call as Array<{ accountId: string } | undefined>)[0] as
              | { accountId: string }
              | undefined
          )?.accountId,
      ),
    ).toEqual(["work", "default"]);
    expect(result.channels).toBeUndefined();
  });
});
