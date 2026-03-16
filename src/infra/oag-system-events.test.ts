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
const statMock = vi.hoisted(() => vi.fn(async () => ({ mtimeMs: Date.now() })));
const inferSessionReplyLanguageMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: readFileMock,
    writeFile: writeFileMock,
    mkdir: mkdirMock,
    rm: rmMock,
    stat: statMock,
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
    readFileMock.mockClear();
    writeFileMock.mockClear();
    mkdirMock.mockClear();
    rmMock.mockClear();
    statMock.mockClear();
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
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(writeFileMock.mock.calls[0]?.[0]).toBe(`${statePath}.lock/pid`);
  });

  it("returns empty array when pending_user_notes is empty", async () => {
    setStateFile({
      pending_user_notes: [],
      delivered_user_notes: [{ id: "history" }],
    });

    await expect(consumePendingOagSystemNotes("telegram:+1234")).resolves.toEqual([]);

    expect(writeFileMock).toHaveBeenCalledTimes(1);
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
});
