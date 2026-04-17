import { beforeEach, describe, expect, it, vi } from "vitest";

const select = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());
const note = vi.hoisted(() => vi.fn());

vi.mock("../channels/chat-meta.js", () => ({
  listChatChannels: () => [
    { id: "telegram", label: "Telegram" },
    { id: "twitch", label: "Twitch" },
  ],
}));

vi.mock("../terminal/note.js", () => ({
  note: (...args: unknown[]) => note(...args),
}));

vi.mock("./configure.shared.js", () => ({
  select: (params: unknown) => select(params),
  confirm: (params: unknown) => confirm(params),
}));

import { removeChannelConfigWizard } from "./configure.channels.js";

describe("removeChannelConfigWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirm.mockResolvedValue(true);
  });

  it("lists configured channels from openclaw.json even when no plugins are loaded", async () => {
    select.mockResolvedValue("done");

    await removeChannelConfigWizard(
      {
        channels: {
          twitch: {},
          unknown: {},
          telegram: {},
        },
      } as never,
      {} as never,
    );

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Remove which channel config?",
        options: [
          expect.objectContaining({ value: "telegram", label: "Telegram" }),
          expect.objectContaining({ value: "twitch", label: "Twitch" }),
          expect.objectContaining({ value: "unknown", label: "unknown" }),
          { value: "done", label: "Done" },
        ],
      }),
    );
  });

  it("deletes the selected channel block from openclaw.json", async () => {
    select.mockResolvedValueOnce("telegram").mockResolvedValueOnce("done");

    const next = await removeChannelConfigWizard(
      {
        channels: {
          telegram: { token: "secret" },
          twitch: { token: "secret" },
        },
      } as never,
      {} as never,
    );

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Delete Telegram configuration from ~/.openclaw/openclaw.json?",
      }),
    );
    expect(next.channels).toEqual({ twitch: { token: "secret" } });
    expect(note).toHaveBeenCalledWith(
      "Telegram removed from config.\nNote: credentials/sessions on disk are unchanged.",
      "Channel removed",
    );
  });

  it("sanitizes unknown channel keys before rendering prompts", async () => {
    const unsafeChannel = "bad\u001B[31m\nkey\u0007";
    select.mockResolvedValueOnce(unsafeChannel).mockResolvedValueOnce("done");

    const next = await removeChannelConfigWizard(
      {
        channels: {
          [unsafeChannel]: { token: "secret" },
          telegram: { token: "secret" },
        },
      } as never,
      {} as never,
    );

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({ value: unsafeChannel, label: "bad\\nkey" }),
        ]),
      }),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Delete bad\\nkey configuration from ~/.openclaw/openclaw.json?",
      }),
    );
    expect(next.channels).toEqual({ telegram: { token: "secret" } });
    expect(note).toHaveBeenCalledWith(
      "bad\\nkey removed from config.\nNote: credentials/sessions on disk are unchanged.",
      "Channel removed",
    );
  });
});
