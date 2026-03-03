import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { runImapService } from "./imap-ops.js";
import { startImapWatcher, stopImapWatcher } from "./imap-watcher.js";

vi.mock("../agents/skills.js", () => ({
  hasBinary: vi.fn(() => true),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn(),
  };
});

vi.mock("./imap-watcher.js", () => ({
  startImapWatcher: vi.fn(),
  stopImapWatcher: vi.fn(),
}));

describe("imap-ops", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("throws when watcher does not start", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      hooks: {
        enabled: true,
        token: "hook-token",
        imap: { account: "configured-account" },
      },
    } satisfies OpenClawConfig);
    vi.mocked(startImapWatcher).mockResolvedValue({
      started: false,
      reason: "himalaya binary not found",
    });

    await expect(runImapService({ account: "override-account" })).rejects.toThrow(
      "himalaya binary not found",
    );
    expect(stopImapWatcher).not.toHaveBeenCalled();
  });
});
