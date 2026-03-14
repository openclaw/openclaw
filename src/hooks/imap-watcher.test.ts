import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { listEnvelopes, markEnvelopeSeen } from "./imap-himalaya.js";
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => "",
      })),
    );
  });

  afterEach(async () => {
    await stopImapWatcher();
    vi.unstubAllGlobals();
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

  it("processes unread envelopes beyond page 1 when markSeen is disabled", async () => {
    const mkEnvelope = (id: string) => ({
      id,
      from: "sender@example.com",
      subject: `subject-${id}`,
      date: "2026-03-03T00:00:00.000Z",
      flags: [],
    });
    const firstPage = Array.from({ length: 50 }, (_, index) => mkEnvelope(`id-${index + 1}`));
    const secondPage = Array.from({ length: 10 }, (_, index) => mkEnvelope(`id-${index + 51}`));

    vi.mocked(listEnvelopes).mockImplementation(async ({ page }) => {
      if ((page ?? 1) === 1) {
        return firstPage;
      }
      if (page === 2) {
        return secondPage;
      }
      return [];
    });

    const cfg: OpenClawConfig = {
      hooks: {
        enabled: true,
        token: "hook-token",
        imap: {},
      },
    };

    const result = await startImapWatcher(cfg, {
      account: "override-account",
      includeBody: false,
      markSeen: false,
      allowedSenders: ["sender@example.com"],
    });
    expect(result).toEqual({ started: true });

    await vi.runOnlyPendingTimersAsync();

    const requestedPages = vi.mocked(listEnvelopes).mock.calls.map(([params]) => params.page ?? 1);
    expect(requestedPages).toEqual([1, 2, 3]);

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(60);

    const deliveredIds = fetchMock.mock.calls.map(([, init]) => {
      const request = init as RequestInit;
      const rawBody = request.body;
      if (typeof rawBody !== "string") {
        throw new TypeError("expected JSON string request body");
      }
      const payload = JSON.parse(rawBody) as {
        messages: Array<{ id: string }>;
      };
      return payload.messages[0]?.id;
    });
    expect(deliveredIds).toContain("id-60");
    expect(vi.mocked(markEnvelopeSeen)).not.toHaveBeenCalled();
  });

  it("continues pagination when current page is fully already seen", async () => {
    const mkEnvelope = (id: string) => ({
      id,
      from: "sender@example.com",
      subject: `subject-${id}`,
      date: "2026-03-03T00:00:00.000Z",
      flags: [],
    });

    let mode: "initial" | "seen-page" = "initial";
    vi.mocked(listEnvelopes).mockImplementation(async ({ page }) => {
      if ((page ?? 1) === 1) {
        return [mkEnvelope("id-1"), mkEnvelope("id-2")];
      }

      if (page === 2 && mode === "initial") {
        return [];
      }

      if (page === 2 && mode === "seen-page") {
        return [mkEnvelope("id-3")];
      }

      return [];
    });

    const cfg: OpenClawConfig = {
      hooks: {
        enabled: true,
        token: "hook-token",
        imap: {},
      },
    };

    const result = await startImapWatcher(cfg, {
      account: "override-account",
      includeBody: false,
      markSeen: false,
      pollIntervalSeconds: 3600,
      allowedSenders: ["sender@example.com"],
    });
    expect(result).toEqual({ started: true });

    await vi.advanceTimersByTimeAsync(0);
    mode = "seen-page";
    vi.mocked(listEnvelopes).mockClear();
    vi.mocked(fetch).mockClear();

    await vi.advanceTimersByTimeAsync(3_600_000);

    const requestedPages = vi.mocked(listEnvelopes).mock.calls.map(([params]) => params.page ?? 1);
    expect(requestedPages).toEqual([1, 2, 3]);

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects display name spoofing against allowed sender", async () => {
    vi.mocked(listEnvelopes).mockResolvedValue([
      {
        id: "id-1",
        from: "owner@example.com <attacker@evil.com>",
        subject: "suspicious",
        date: "2026-03-03T00:00:00.000Z",
        flags: [],
      },
    ]);

    const cfg: OpenClawConfig = {
      hooks: {
        enabled: true,
        token: "hook-token",
        imap: {},
      },
    };

    const result = await startImapWatcher(cfg, {
      account: "override-account",
      includeBody: false,
      markSeen: false,
      allowedSenders: ["owner@example.com"],
    });
    expect(result).toEqual({ started: true });

    await vi.runOnlyPendingTimersAsync();

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("accepts allowed sender when angle address matches", async () => {
    vi.mocked(listEnvelopes).mockResolvedValue([
      {
        id: "id-1",
        from: "Owner <owner@example.com>",
        subject: "trusted",
        date: "2026-03-03T00:00:00.000Z",
        flags: [],
      },
    ]);

    const cfg: OpenClawConfig = {
      hooks: {
        enabled: true,
        token: "hook-token",
        imap: {},
      },
    };

    const result = await startImapWatcher(cfg, {
      account: "override-account",
      includeBody: false,
      markSeen: false,
      allowedSenders: ["owner@example.com"],
    });
    expect(result).toEqual({ started: true });

    await vi.runOnlyPendingTimersAsync();

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});
