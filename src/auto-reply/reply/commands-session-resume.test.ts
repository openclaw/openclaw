import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry, SessionHistoryEntry } from "../../config/sessions.js";
import * as sessions from "../../config/sessions.js";
import * as sessionUtilsFs from "../../gateway/session-utils.fs.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const fsMockState = vi.hoisted(() => ({
  existsSyncResults: [] as boolean[],
  readdirByDir: new Map<string, string[]>(),
  readdirCalls: [] as string[],
  renameArgs: null as [string, string] | null,
  copyFileArgs: null as [string, string] | null,
  unlinkArg: null as string | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const wrapped = {
    ...actual,
    existsSync: vi.fn(() => fsMockState.existsSyncResults.shift() ?? false),
  };
  return { ...wrapped, default: wrapped };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const wrapped = {
    ...actual,
    mkdir: vi.fn(async () => undefined),
    readdir: vi.fn(async (dir: string) => {
      fsMockState.readdirCalls.push(dir);
      return fsMockState.readdirByDir.get(dir) ?? [];
    }),
    rename: vi.fn(async (from: string, to: string) => {
      fsMockState.renameArgs = [from, to];
    }),
    copyFile: vi.fn(async (from: string, to: string) => {
      fsMockState.copyFileArgs = [from, to];
    }),
    unlink: vi.fn(async (file: string) => {
      fsMockState.unlinkArg = file;
    }),
  };
  return { ...wrapped, default: wrapped };
});

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...actual,
    MAX_SESSION_HISTORY: 20,
    updateSessionStore: vi.fn(),
    parseSessionArchiveTimestamp: vi.fn((fileName: string, reason: string) => {
      const match = fileName.match(new RegExp(`\\.${reason}\\.(\\d+)$`));
      return match ? Number(match[1]) : null;
    }),
  };
});

vi.mock("../../gateway/session-utils.fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gateway/session-utils.fs.js")>();
  return {
    ...actual,
    resolveSessionTranscriptCandidates: vi.fn(() => [] as string[]),
    resolveSessionEntryLabel: vi.fn(() => undefined),
  };
});

vi.mock("../../infra/format-time/format-relative.js", () => ({
  formatRelativeTimestamp: vi.fn(() => "3h ago"),
}));

const { handleResumeCommand } = await import("./commands-session-resume.js");

type UpdateSessionStoreMutator = Parameters<typeof sessions.updateSessionStore>[1];
type UpdateSessionStoreOptions = Parameters<typeof sessions.updateSessionStore>[2];

function buildParams(commandBody: string, history: SessionHistoryEntry[] = []) {
  const params = buildCommandTestParams(commandBody, {
    commands: { text: true },
    channels: { whatsapp: { allowFrom: ["*"] } },
  });
  params.storePath = "/tmp/fake/sessions.json";
  params.agentId = "main";
  params.sessionKey = "agent:main:main";
  params.sessionEntry = {
    sessionId: "current-session-id",
    updatedAt: Date.now(),
    history,
    systemSent: true,
  } as SessionEntry;
  return params;
}

const sampleHistory: SessionHistoryEntry[] = [
  {
    sessionId: "aaaabbbbccccdddd",
    sessionFile: "/tmp/fake/aaaabbbbccccdddd.jsonl",
    updatedAt: Date.now() - 5_000,
    label: "first",
    systemSent: true,
  },
  {
    sessionId: "1111222233334444",
    sessionFile: "/tmp/fake/1111222233334444.jsonl",
    updatedAt: Date.now() - 10_000,
    label: "second",
    systemSent: false,
  },
];

describe("handleResumeCommand", () => {
  afterEach(() => {
    vi.clearAllMocks();
    fsMockState.existsSyncResults = [];
    fsMockState.readdirByDir = new Map<string, string[]>();
    fsMockState.readdirCalls = [];
    fsMockState.renameArgs = null;
    fsMockState.copyFileArgs = null;
    fsMockState.unlinkArg = null;
  });

  it("returns null for non-resume command", async () => {
    const result = await handleResumeCommand(buildParams("/new"), true);
    expect(result).toBeNull();
  });

  it("blocks unauthorized sender", async () => {
    const params = buildParams("/resume", sampleHistory);
    params.command.isAuthorizedSender = false;
    const result = await handleResumeCommand(params, true);
    expect(result).toEqual({ shouldContinue: false });
  });

  it("lists recent sessions", async () => {
    const result = await handleResumeCommand(buildParams("/resume", sampleHistory), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Recent sessions:");
    expect(result?.reply?.text).toContain("1. `aaaabbbb` 3h ago - first");
    expect(result?.reply?.text).toContain("Use /resume #<index> or /resume <id> to switch.");
  });

  it("uses #index for index-based resume", async () => {
    vi.mocked(sessionUtilsFs.resolveSessionTranscriptCandidates).mockReturnValueOnce([
      "/tmp/fake/1111222233334444.jsonl",
    ]);
    fsMockState.existsSyncResults = [true];
    vi.mocked(sessions.updateSessionStore).mockImplementationOnce(
      async (
        _path: string,
        mutate: UpdateSessionStoreMutator,
        _opts?: UpdateSessionStoreOptions,
      ) => {
        const store: Record<string, SessionEntry> = {};
        await mutate(store);
        expect(store["agent:main:main"]?.sessionId).toBe("1111222233334444");
        return undefined;
      },
    );

    const result = await handleResumeCommand(buildParams("/resume #2", sampleHistory), true);
    expect(result?.reply?.text).toContain("Resumed session `11112222`");
  });

  it("does not treat bare numeric argument as index", async () => {
    const result = await handleResumeCommand(buildParams("/resume 2", sampleHistory), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Session not found");
  });

  it("restores newest reset archive when live transcript is missing", async () => {
    vi.mocked(sessionUtilsFs.resolveSessionTranscriptCandidates).mockReturnValueOnce([
      "/tmp/fake/aaaabbbbccccdddd.jsonl",
    ]);
    fsMockState.existsSyncResults = [false];
    fsMockState.readdirByDir.set("/tmp/fake", [
      "aaaabbbbccccdddd.jsonl.reset.100",
      "aaaabbbbccccdddd.jsonl.reset.200",
    ]);
    vi.mocked(sessions.updateSessionStore).mockResolvedValueOnce(undefined);

    const result = await handleResumeCommand(buildParams("/resume aaaabbbb", sampleHistory), true);
    expect(result?.reply?.text).toContain("Resumed session `aaaabbbb`");
    expect(fsMockState.renameArgs).toEqual([
      path.join("/tmp/fake", "aaaabbbbccccdddd.jsonl.reset.200"),
      path.join("/tmp/fake", "aaaabbbbccccdddd.jsonl"),
    ]);
  });

  it("does not scan or import outside raw sessionFile paths", async () => {
    vi.mocked(sessionUtilsFs.resolveSessionTranscriptCandidates).mockReturnValueOnce([
      "/tmp/fake/aaaabbbbccccdddd.jsonl",
    ]);
    fsMockState.existsSyncResults = [false];
    fsMockState.readdirByDir.set("/tmp/fake", ["secret.jsonl.reset.200"]);
    vi.mocked(sessions.updateSessionStore).mockResolvedValueOnce(undefined);

    const history = [
      {
        ...sampleHistory[0],
        sessionFile: "/tmp/outside/secret.jsonl",
      },
    ];
    const result = await handleResumeCommand(buildParams("/resume aaaabbbb", history), true);

    expect(result?.reply?.text).toContain("Resumed session `aaaabbbb`");
    expect(fsMockState.readdirCalls).toStrictEqual(["/tmp/fake"]);
    expect(fsMockState.copyFileArgs).toBeNull();
    expect(fsMockState.renameArgs).toEqual([
      path.join("/tmp/fake", "secret.jsonl.reset.200"),
      path.join("/tmp/fake", "secret.jsonl"),
    ]);
  });
});
