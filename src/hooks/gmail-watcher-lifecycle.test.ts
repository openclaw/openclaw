import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startGmailWatcherWithLogs } from './gmail-watcher-lifecycle.js';
import { startGmailWatcher } from './gmail-watcher.js';

vi.mock('./gmail-watcher.js', () => ({
  startGmailWatcher: vi.fn(),
}));

const startGmailWatcherMock = vi.mocked(startGmailWatcher);

describe('gmail-watcher-lifecycle', () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs actionable non-start reason correctly", async () => {
    // Simulate a failed start with a generic reason (no suffix expected)
    startGmailWatcherMock.mockResolvedValue({ 
      started: false, 
      status: "skipped", 
      reason: "auth failed" 
    });

    await startGmailWatcherWithLogs({
      cfg: {} as any,
      log,
    });

    // The test now correctly expects NO suffix for generic errors
    expect(log.warn).toHaveBeenCalledWith("gmail watcher not started: auth failed");
  });

  it("logs external webhook note for specific reason", async () => {
    // Simulate the specific reason that triggers the note
    startGmailWatcherMock.mockResolvedValue({ 
      started: false, 
      status: "skipped", 
      reason: "gmail topic required" 
    });

    await startGmailWatcherWithLogs({
      cfg: {} as any,
      log,
    });

    expect(log.warn).toHaveBeenCalledWith(
      "gmail watcher not started: gmail topic required. Note: If using an external webhook (e.g. gog + Pub/Sub), this is expected. Ensure your configured Gmail hook endpoint is reachable."
    );
  });
});