import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const homeDir = "/tmp/openclaw-oag-tests";
const statePath = `${homeDir}/.openclaw/sentinel/channel-health-state.json`;

const mockState = vi.hoisted(() => ({
  files: new Map<string, string>(),
}));

const readFileMock = vi.hoisted(() =>
  vi.fn(async (filePath: string) => {
    if (!mockState.files.has(filePath)) {
      throw new Error(`ENOENT: ${filePath}`);
    }
    return mockState.files.get(filePath) ?? "";
  }),
);

const writeFileMock = vi.hoisted(() =>
  vi.fn(async (filePath: string, content: string | Buffer) => {
    mockState.files.set(filePath, typeof content === "string" ? content : content.toString("utf8"));
  }),
);

const mkdirMock = vi.hoisted(() => vi.fn(async () => {}));
const rmMock = vi.hoisted(() => vi.fn(async () => {}));
const unlinkMock = vi.hoisted(() => vi.fn(async () => {}));
const statMock = vi.hoisted(() => vi.fn(async () => ({ mtimeMs: Date.now() })));
const inferSessionReplyLanguageMock = vi.hoisted(() => vi.fn());

const openMock = vi.hoisted(() => {
  const mockFd = {
    writeFile: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  return {
    fn: vi.fn(async () => mockFd),
    mockFd,
  };
});

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: readFileMock,
    writeFile: writeFileMock,
    mkdir: mkdirMock,
    rm: rmMock,
    unlink: unlinkMock,
    stat: statMock,
    open: openMock.fn,
  },
}));

vi.mock("./session-language.js", () => ({
  inferSessionReplyLanguage: inferSessionReplyLanguageMock,
}));

const { consumePendingOagSystemNotes } = await import("./oag-system-events.js");

function setStateFile(state: unknown): void {
  mockState.files.set(statePath, JSON.stringify(state, null, 2));
}

function getWrittenState(): {
  pending_user_notes?: Array<Record<string, unknown>>;
  delivered_user_notes?: Array<Record<string, unknown>>;
} {
  return JSON.parse(mockState.files.get(statePath) ?? "{}") as {
    pending_user_notes?: Array<Record<string, unknown>>;
    delivered_user_notes?: Array<Record<string, unknown>>;
  };
}

describe("consumePendingOagSystemNotes", () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = homeDir;
    mockState.files.clear();
    readFileMock.mockReset();
    readFileMock.mockImplementation(async (filePath: string) => {
      if (!mockState.files.has(filePath)) {
        throw new Error(`ENOENT: ${filePath}`);
      }
      return mockState.files.get(filePath) ?? "";
    });
    writeFileMock.mockReset();
    writeFileMock.mockImplementation(async (filePath: string, content: string | Buffer) => {
      mockState.files.set(
        filePath,
        typeof content === "string" ? content : content.toString("utf8"),
      );
    });
    mkdirMock.mockReset();
    mkdirMock.mockImplementation(async () => {});
    rmMock.mockReset();
    rmMock.mockImplementation(async () => {});
    unlinkMock.mockReset();
    unlinkMock.mockImplementation(async () => {});
    statMock.mockReset();
    statMock.mockImplementation(async () => ({ mtimeMs: Date.now() }));
    openMock.fn.mockReset();
    openMock.mockFd.writeFile.mockReset();
    openMock.mockFd.close.mockReset();
    openMock.fn.mockImplementation(async () => openMock.mockFd);
    openMock.mockFd.writeFile.mockImplementation(async () => {});
    openMock.mockFd.close.mockImplementation(async () => {});
    inferSessionReplyLanguageMock.mockReset();
    inferSessionReplyLanguageMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
      return;
    }
    process.env.HOME = originalHome;
  });

  it("matches session targets with camelCase, snake_case, and case-insensitive comparisons", async () => {
    setStateFile({
      pending_user_notes: [
        {
          id: "camel",
          created_at: "2026-03-16T00:00:03.000Z",
          message: "Camel",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
        {
          id: "case-insensitive",
          created_at: "2026-03-16T00:00:01.000Z",
          message: "Case",
          targets: [{ sessionKeys: ["TeLeGrAm:+1234"] }],
        },
        {
          id: "snake",
          created_at: "2026-03-16T00:00:02.000Z",
          message: "Snake",
          targets: [{ session_keys: ["telegram:+1234"] }],
        },
        {
          id: "no-targets",
          created_at: "2026-03-16T00:00:04.000Z",
          message: "No targets",
        },
      ],
      delivered_user_notes: [],
    });

    const notes = await consumePendingOagSystemNotes("telegram:+1234");

    expect(notes).toEqual([
      { text: "OAG: Case", ts: Date.parse("2026-03-16T00:00:01.000Z") },
      { text: "OAG: Snake", ts: Date.parse("2026-03-16T00:00:02.000Z") },
      { text: "OAG: Camel", ts: Date.parse("2026-03-16T00:00:03.000Z") },
    ]);

    const written = getWrittenState();
    expect(written.pending_user_notes).toHaveLength(1);
    expect(written.pending_user_notes?.[0]?.id).toBe("no-targets");
    expect(written.delivered_user_notes).toHaveLength(3);
  });

  it("returns empty array for an empty session key", async () => {
    setStateFile({
      pending_user_notes: [
        {
          id: "match",
          created_at: "2026-03-16T00:00:00.000Z",
          message: "Match",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
      ],
    });

    await expect(consumePendingOagSystemNotes("   ")).resolves.toEqual([]);
    expect(inferSessionReplyLanguageMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("returns all matching notes sorted ascending, prefixes text, and preserves non-matching pending notes", async () => {
    setStateFile({
      pending_user_notes: [
        {
          id: "latest-input",
          created_at: "2026-03-16T00:00:03.000Z",
          message: "Third",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
        {
          id: "non-match",
          created_at: "2026-03-16T00:00:04.000Z",
          message: "Keep me",
          targets: [{ sessionKeys: ["telegram:+9999"] }],
        },
        {
          id: "earliest-input",
          created_at: "2026-03-16T00:00:01.000Z",
          message: "First",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
        {
          id: "middle-input",
          created_at: "2026-03-16T00:00:02.000Z",
          message: "Second",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
      ],
      delivered_user_notes: [{ id: "old-delivered" }],
    });

    const notes = await consumePendingOagSystemNotes("telegram:+1234");

    expect(notes).toEqual([
      { text: "OAG: First", ts: Date.parse("2026-03-16T00:00:01.000Z") },
      { text: "OAG: Second", ts: Date.parse("2026-03-16T00:00:02.000Z") },
      { text: "OAG: Third", ts: Date.parse("2026-03-16T00:00:03.000Z") },
    ]);

    const written = getWrittenState();
    expect(written.pending_user_notes).toEqual([
      expect.objectContaining({
        id: "non-match",
        targets: [{ sessionKeys: ["telegram:+9999"] }],
      }),
    ]);
    expect(written.delivered_user_notes).toHaveLength(4);
    expect(written.delivered_user_notes?.map((note) => note.id)).toEqual([
      "old-delivered",
      "latest-input",
      "earliest-input",
      "middle-input",
    ]);
    for (const note of written.delivered_user_notes?.slice(1) ?? []) {
      expect(note.delivered_session_key).toBe("telegram:+1234");
      expect(typeof note.delivered_at).toBe("string");
    }
  });

  it("caps delivered_user_notes at 20 entries", async () => {
    setStateFile({
      pending_user_notes: [
        {
          id: "fresh-a",
          created_at: "2026-03-16T00:00:01.000Z",
          message: "Fresh A",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
        {
          id: "fresh-b",
          created_at: "2026-03-16T00:00:02.000Z",
          message: "Fresh B",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
      ],
      delivered_user_notes: Array.from({ length: 19 }, (_, index) => ({
        id: `history-${index + 1}`,
      })),
    });

    await consumePendingOagSystemNotes("telegram:+1234");

    const deliveredIds = getWrittenState().delivered_user_notes?.map((note) => note.id);
    expect(deliveredIds).toHaveLength(20);
    expect(deliveredIds).not.toContain("history-1");
    expect(deliveredIds?.slice(-2)).toEqual(["fresh-a", "fresh-b"]);
  });

  it("returns empty array when no state file exists", async () => {
    readFileMock.mockRejectedValueOnce(new Error("ENOENT"));

    await expect(consumePendingOagSystemNotes("telegram:+1234")).resolves.toEqual([]);
    expect(openMock.fn).toHaveBeenCalledWith(`${statePath}.lock`, "wx");
  });

  it("returns empty array when pending_user_notes is empty", async () => {
    setStateFile({
      pending_user_notes: [],
      delivered_user_notes: [{ id: "history" }],
    });

    await expect(consumePendingOagSystemNotes("telegram:+1234")).resolves.toEqual([]);

    // State file is not rewritten when there are no matching notes to consume.
    expect(writeFileMock).toHaveBeenCalledTimes(0);
    expect(getWrittenState()).toEqual({
      pending_user_notes: [],
      delivered_user_notes: [{ id: "history" }],
    });
  });

  it("uses English hardcoded messages when language is undefined or en", async () => {
    setStateFile({
      pending_user_notes: [
        {
          id: "english-default",
          action: "recovery_verify",
          created_at: "2026-03-16T00:00:01.000Z",
          message: "raw zh note",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
      ],
    });

    await expect(consumePendingOagSystemNotes("telegram:+1234")).resolves.toEqual([
      {
        text: "OAG: I ran a recovery check for a channel that did not recover cleanly.",
        ts: Date.parse("2026-03-16T00:00:01.000Z"),
      },
    ]);

    setStateFile({
      pending_user_notes: [
        {
          id: "english-explicit",
          action: "recovery_verify",
          created_at: "2026-03-16T00:00:02.000Z",
          message: "raw zh note",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
      ],
    });
    inferSessionReplyLanguageMock.mockResolvedValueOnce("en");

    await expect(consumePendingOagSystemNotes("telegram:+1234")).resolves.toEqual([
      {
        text: "OAG: I ran a recovery check for a channel that did not recover cleanly.",
        ts: Date.parse("2026-03-16T00:00:02.000Z"),
      },
    ]);
  });

  it("uses the raw note message for zh-Hans", async () => {
    setStateFile({
      pending_user_notes: [
        {
          id: "zh",
          action: "recovery_verify",
          created_at: "2026-03-16T00:00:01.000Z",
          message: "我运行了恢复检查。",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
      ],
    });
    inferSessionReplyLanguageMock.mockResolvedValueOnce("zh-Hans");

    await expect(consumePendingOagSystemNotes("telegram:+1234")).resolves.toEqual([
      {
        text: "OAG: 我运行了恢复检查。",
        ts: Date.parse("2026-03-16T00:00:01.000Z"),
      },
    ]);
  });

  it("uses Japanese messages for ja language", async () => {
    setStateFile({
      pending_user_notes: [
        {
          id: "ja-test",
          action: "recovery_verify",
          created_at: "2026-03-17T00:00:01.000Z",
          message: "raw message",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
      ],
    });
    inferSessionReplyLanguageMock.mockResolvedValueOnce("ja");
    const notes = await consumePendingOagSystemNotes("telegram:+1234");
    expect(notes[0].text).toContain("正常に復旧しなかった");
  });

  it("uses Korean messages for ko language", async () => {
    setStateFile({
      pending_user_notes: [
        {
          id: "ko-test",
          action: "gateway_restart_triggered",
          created_at: "2026-03-17T00:00:01.000Z",
          message: "raw message",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
      ],
    });
    inferSessionReplyLanguageMock.mockResolvedValueOnce("ko");
    const notes = await consumePendingOagSystemNotes("telegram:+1234");
    expect(notes[0].text).toContain("재시작했습니다");
  });
});

describe("note deduplication", () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = homeDir;
    mockState.files.clear();
    readFileMock.mockReset();
    readFileMock.mockImplementation(async (filePath: string) => {
      if (!mockState.files.has(filePath)) {
        throw new Error(`ENOENT: ${filePath}`);
      }
      return mockState.files.get(filePath) ?? "";
    });
    writeFileMock.mockReset();
    writeFileMock.mockImplementation(async (filePath: string, content: string | Buffer) => {
      mockState.files.set(
        filePath,
        typeof content === "string" ? content : content.toString("utf8"),
      );
    });
    mkdirMock.mockReset();
    mkdirMock.mockImplementation(async () => {});
    rmMock.mockReset();
    rmMock.mockImplementation(async () => {});
    unlinkMock.mockReset();
    unlinkMock.mockImplementation(async () => {});
    statMock.mockReset();
    statMock.mockImplementation(async () => ({ mtimeMs: Date.now() }));
    openMock.fn.mockReset();
    openMock.mockFd.writeFile.mockReset();
    openMock.mockFd.close.mockReset();
    openMock.fn.mockImplementation(async () => openMock.mockFd);
    openMock.mockFd.writeFile.mockImplementation(async () => {});
    openMock.mockFd.close.mockImplementation(async () => {});
    inferSessionReplyLanguageMock.mockReset();
    inferSessionReplyLanguageMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
      return;
    }
    process.env.HOME = originalHome;
  });

  it("deduplicates notes with the same action within 60s window", async () => {
    setStateFile({
      pending_user_notes: [
        {
          id: "a1",
          action: "channel_backlog_cleared",
          created_at: "2026-03-16T00:00:01.000Z",
          message: "Cleared 1",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
        {
          id: "a2",
          action: "channel_backlog_cleared",
          created_at: "2026-03-16T00:00:30.000Z",
          message: "Cleared 2",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
      ],
    });

    const notes = await consumePendingOagSystemNotes("telegram:+1234");
    // Within 60s window, only the most recent is shown
    expect(notes).toHaveLength(1);
    // channel_backlog_cleared maps to the hardcoded English message
    expect(notes[0].text).toContain("Channel backlog cleared and delivery resumed.");

    // But both are in delivered_user_notes
    const written = getWrittenState();
    expect(written.delivered_user_notes).toHaveLength(2);
  });

  it("preserves notes with different actions", async () => {
    setStateFile({
      pending_user_notes: [
        {
          id: "b1",
          action: "recovery_verify",
          created_at: "2026-03-16T00:00:01.000Z",
          message: "Verify",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
        {
          id: "b2",
          action: "channel_backlog_cleared",
          created_at: "2026-03-16T00:00:02.000Z",
          message: "Cleared",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
      ],
    });

    const notes = await consumePendingOagSystemNotes("telegram:+1234");
    expect(notes).toHaveLength(2);
  });

  it("preserves duplicate actions outside the 60s window", async () => {
    setStateFile({
      pending_user_notes: [
        {
          id: "c1",
          action: "recovery_verify",
          created_at: "2026-03-16T00:00:01.000Z",
          message: "First verify",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
        {
          id: "c2",
          action: "recovery_verify",
          created_at: "2026-03-16T00:05:00.000Z",
          message: "Second verify",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
      ],
    });

    const notes = await consumePendingOagSystemNotes("telegram:+1234");
    // 5 minutes apart → both preserved
    expect(notes).toHaveLength(2);
  });
});

describe("stale lock recovery", () => {
  const originalHome = process.env.HOME;
  const lockPath = `${statePath}.lock`;

  beforeEach(() => {
    process.env.HOME = homeDir;
    mockState.files.clear();
    readFileMock.mockReset();
    readFileMock.mockImplementation(async (filePath: string) => {
      if (!mockState.files.has(filePath)) {
        throw new Error(`ENOENT: ${filePath}`);
      }
      return mockState.files.get(filePath) ?? "";
    });
    writeFileMock.mockReset();
    writeFileMock.mockImplementation(async (filePath: string, content: string | Buffer) => {
      mockState.files.set(
        filePath,
        typeof content === "string" ? content : content.toString("utf8"),
      );
    });
    mkdirMock.mockReset();
    mkdirMock.mockImplementation(async () => {});
    rmMock.mockReset();
    rmMock.mockImplementation(async () => {});
    unlinkMock.mockReset();
    unlinkMock.mockImplementation(async () => {});
    statMock.mockReset();
    statMock.mockImplementation(async () => ({ mtimeMs: Date.now() }));
    openMock.fn.mockReset();
    openMock.mockFd.writeFile.mockReset();
    openMock.mockFd.close.mockReset();
    openMock.fn.mockImplementation(async () => openMock.mockFd);
    openMock.mockFd.writeFile.mockImplementation(async () => {});
    openMock.mockFd.close.mockImplementation(async () => {});
    inferSessionReplyLanguageMock.mockReset();
    inferSessionReplyLanguageMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
      return;
    }
    process.env.HOME = originalHome;
  });

  it("recovers from stale lock when holding process is dead", async () => {
    setStateFile({
      pending_user_notes: [
        {
          id: "stale-dead-pid",
          created_at: "2026-03-16T00:00:01.000Z",
          message: "Recovered",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
      ],
      delivered_user_notes: [],
    });
    // Seed the lock file directly with a dead PID
    mockState.files.set(lockPath, "99999999");
    openMock.fn
      .mockImplementationOnce(async () => {
        const error = new Error("EEXIST") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      })
      .mockImplementationOnce(async () => openMock.mockFd);

    await expect(consumePendingOagSystemNotes("telegram:+1234")).resolves.toEqual([
      {
        text: "OAG: Recovered",
        ts: Date.parse("2026-03-16T00:00:01.000Z"),
      },
    ]);

    expect(unlinkMock).toHaveBeenCalledWith(lockPath);
    expect(openMock.mockFd.writeFile).toHaveBeenCalledWith(String(process.pid), "utf8");
  });

  it("recovers from stale lock when no lock file content exists (stale file)", async () => {
    setStateFile({
      pending_user_notes: [
        {
          id: "legacy-lock",
          created_at: "2026-03-16T00:00:01.000Z",
          message: "Recovered",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
      ],
      delivered_user_notes: [],
    });
    openMock.fn
      .mockImplementationOnce(async () => {
        const error = new Error("EEXIST") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      })
      .mockImplementationOnce(async () => openMock.mockFd);
    // readFile for the lockPath throws ENOENT — no content, treated as stale
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath === lockPath) {
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      if (!mockState.files.has(filePath)) {
        throw new Error(`ENOENT: ${filePath}`);
      }
      return mockState.files.get(filePath) ?? "";
    });

    await expect(consumePendingOagSystemNotes("telegram:+1234")).resolves.toEqual([
      {
        text: "OAG: Recovered",
        ts: Date.parse("2026-03-16T00:00:01.000Z"),
      },
    ]);

    expect(unlinkMock).toHaveBeenCalledWith(lockPath);
  });

  it("writes PID into lock file after acquiring lock", async () => {
    setStateFile({
      pending_user_notes: [
        {
          id: "pid-write",
          created_at: "2026-03-16T00:00:01.000Z",
          message: "PID",
          targets: [{ sessionKeys: ["telegram:+1234"] }],
        },
      ],
      delivered_user_notes: [],
    });

    await consumePendingOagSystemNotes("telegram:+1234");

    expect(openMock.mockFd.writeFile).toHaveBeenCalledWith(String(process.pid), "utf8");
  });
});
