import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { startImapWatcher, stopImapWatcher } from "./imap-watcher.js";

vi.mock("../agents/skills.js", () => ({
  hasBinary: vi.fn(() => true),
}));

vi.mock("./imap-himalaya.js", () => ({
  listEnvelopes: vi.fn(async () => []),
  readMessage: vi.fn(),
  markEnvelopeSeen: vi.fn(),
}));

describe("imap-watcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await stopImapWatcher();
    vi.useRealTimers();
  });

  it("starts when account is provided via overrides", async () => {
    const cfg: OpenClawConfig = {
      hooks: {
        enabled: true,
        token: "hook-token",
        imap: {},
      },
    };

    const result = await startImapWatcher(cfg, { account: "override-account" });
    expect(result).toEqual({ started: true });
  });
});
