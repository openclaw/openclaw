// Message formatter tests cover user-visible action summaries.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../packages/terminal-core/src/table.js", () => ({
  getTerminalTableWidth: () => 100,
  renderTable: ({ rows }: { rows: Array<Record<string, unknown>> }) =>
    rows.map((row) => Object.values(row).join(" | ")).join("\n"),
}));

vi.mock("../../packages/terminal-core/src/theme.js", () => ({
  isRich: () => false,
  theme: {
    heading: (text: string) => text,
    muted: (text: string) => text,
    success: (text: string) => text,
  },
}));

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: () => undefined,
  getLoadedChannelPlugin: () => undefined,
}));

import { formatMessageCliText } from "./message-format.js";

describe("formatMessageCliText", () => {
  it("summarizes broadcast successes and failures", () => {
    const lines = formatMessageCliText({
      kind: "broadcast",
      channel: "telegram",
      action: "broadcast",
      handledBy: "core",
      dryRun: false,
      payload: {
        results: [
          { channel: "telegram", to: "chat-1", ok: true },
          { channel: "discord", to: "chat-2", ok: false, error: "missing webhook" },
          { channel: "slack", to: "chat-3", ok: true },
        ],
      },
    });

    expect(lines[0]).toBe("✅ Broadcast complete (2/3 succeeded, 1 failed)");
    expect(lines.join("\n")).toContain("missing webhook");
  });
});
