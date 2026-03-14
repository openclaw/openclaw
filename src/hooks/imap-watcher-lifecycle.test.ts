import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { startImapWatcherWithLogs } from "./imap-watcher-lifecycle.js";

vi.mock("./imap-watcher.js", () => ({
  startImapWatcher: vi.fn().mockResolvedValue({ started: false, reason: "hooks not enabled" }),
}));

describe("imap-watcher-lifecycle", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_SKIP_IMAP_WATCHER;
  });

  it("skips when OPENCLAW_SKIP_IMAP_WATCHER is set", async () => {
    process.env.OPENCLAW_SKIP_IMAP_WATCHER = "1";
    const onSkipped = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await startImapWatcherWithLogs({
      cfg: {} as OpenClawConfig,
      log,
      onSkipped,
    });
    expect(onSkipped).toHaveBeenCalledOnce();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("logs warning when watcher cannot start for a meaningful reason", async () => {
    const { startImapWatcher } = await import("./imap-watcher.js");
    vi.mocked(startImapWatcher).mockResolvedValueOnce({
      started: false,
      reason: "himalaya binary not found",
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await startImapWatcherWithLogs({ cfg: {} as OpenClawConfig, log });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("himalaya binary not found"));
  });

  it("does not warn for silent non-start reasons", async () => {
    const { startImapWatcher } = await import("./imap-watcher.js");
    vi.mocked(startImapWatcher).mockResolvedValueOnce({
      started: false,
      reason: "imap account required",
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await startImapWatcherWithLogs({ cfg: {} as OpenClawConfig, log });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });
});
