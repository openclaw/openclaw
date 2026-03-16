import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry, SessionHistoryEntry } from "../../config/sessions.js";
import * as sessions from "../../config/sessions.js";
import * as sessionUtilsFs from "../../gateway/session-utils.fs.js";
import { handleResumeCommand } from "./commands-session-resume.js";
import type { HandleCommandsParams } from "./commands-types.js";

// ---------- shared mutable state for file-system mocks ----------
const fsMockState = vi.hoisted(() => ({
  existsSyncResults: [] as boolean[],
  readdirResult: [] as string[],
  readdirByDir: null as Map<string, string[]> | null,
  renameArgs: null as [string, string] | null,
  renameError: null as (Error & { code?: string }) | null,
  copyFileArgs: null as [string, string] | null,
  copyFileError: null as Error | null,
  unlinkArgs: null as string | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const wrapped = {
    ...actual,
    existsSync: vi.fn((_p: unknown) => {
      return fsMockState.existsSyncResults.shift() ?? false;
    }),
  };
  return { ...wrapped, default: wrapped };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const wrapped = {
    ...actual,
    readdir: vi.fn(
      async (dir: unknown) =>
        fsMockState.readdirByDir?.get(dir as string) ?? fsMockState.readdirResult,
    ),
    rename: vi.fn(async (from: unknown, to: unknown) => {
      if (fsMockState.renameError) {
        const err = fsMockState.renameError;
        fsMockState.renameError = null;
        throw err;
      }
      fsMockState.renameArgs = [from as string, to as string];
    }),
    copyFile: vi.fn(async (from: unknown, to: unknown) => {
      if (fsMockState.copyFileError) {
        const err = fsMockState.copyFileError;
        fsMockState.copyFileError = null;
        throw err;
      }
      fsMockState.copyFileArgs = [from as string, to as string];
    }),
    unlink: vi.fn(async (p: unknown) => {
      fsMockState.unlinkArgs = p as string;
    }),
  };
  return { ...wrapped, default: wrapped };
});

// ---------- sessions + session-utils mocks ----------
// Mock the barrel (not submodules) so that the source file's barrel imports
// resolve to the mock functions. Mocking only a submodule does not update the
// barrel's ESM live re-export bindings used by commands-session-resume.ts.
vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...actual,
    updateSessionStore: vi.fn(),
    parseSessionArchiveTimestamp: vi.fn((filename: string, reason: string) => {
      const re = new RegExp(`\\.${reason}\\.(\\d+)$`);
      const m = filename.match(re);
      return m ? Number(m[1]) : null;
    }),
  };
});

vi.mock("../../gateway/session-utils.fs.js", () => ({
  resolveSessionTranscriptCandidates: vi.fn(() => [] as string[]),
  resolveSessionEntryLabel: vi.fn(() => undefined),
}));

// ---------- helpers ----------
function makeParams(
  commandText: string,
  history: SessionHistoryEntry[] = [],
  storePath = "/tmp/fake/sessions.json",
): HandleCommandsParams {
  return {
    command: {
      surface: "telegram",
      channel: "telegram",
      ownerList: ["owner"],
      senderIsOwner: true,
      isAuthorizedSender: true,
      senderId: "owner",
      rawBodyNormalized: commandText,
      commandBodyNormalized: commandText,
    },
    ctx: {} as HandleCommandsParams["ctx"],
    cfg: {} as HandleCommandsParams["cfg"],
    directives: {} as HandleCommandsParams["directives"],
    elevated: { enabled: false, allowed: false, failures: [] },
    sessionKey: "telegram:owner",
    storePath,
    agentId: "main",
    sessionEntry: {
      sessionId: "current-session-uuid",
      updatedAt: Date.now(),
      systemSent: true,
      history,
    } as SessionEntry,
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "always",
    resolvedVerboseLevel: "normal" as HandleCommandsParams["resolvedVerboseLevel"],
    resolvedReasoningLevel: "normal" as HandleCommandsParams["resolvedReasoningLevel"],
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    contextTokens: 0,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

const sampleHistory: SessionHistoryEntry[] = [
  {
    sessionId: "aaaabbbbccccdddd",
    sessionFile: "/tmp/fake/aaaabbbbccccdddd.jsonl",
    updatedAt: new Date("2026-01-15T10:00:00Z").getTime(),
    label: "chat about TypeScript",
    systemSent: true,
  },
  {
    sessionId: "11112222333344445",
    sessionFile: "/tmp/fake/11112222333344445.jsonl",
    updatedAt: new Date("2026-01-14T08:30:00Z").getTime(),
    systemSent: false,
  },
];

// ---------- tests ----------
describe("handleResumeCommand", () => {
  afterEach(() => {
    vi.clearAllMocks();
    fsMockState.existsSyncResults = [];
    fsMockState.readdirResult = [];
    fsMockState.readdirByDir = null;
    fsMockState.renameArgs = null;
    fsMockState.renameError = null;
    fsMockState.copyFileArgs = null;
    fsMockState.copyFileError = null;
    fsMockState.unlinkArgs = null;
  });

  it("returns null for non-resume commands", async () => {
    const result = await handleResumeCommand(makeParams("/new"), true);
    expect(result).toBeNull();
  });

  it("returns null when text commands are disabled", async () => {
    const result = await handleResumeCommand(makeParams("/resume"), false);
    expect(result).toBeNull();
  });

  it("blocks unauthorized senders", async () => {
    const params = makeParams("/resume");
    params.command.isAuthorizedSender = false;
    const result = await handleResumeCommand(params, true);
    expect(result).toEqual({ shouldContinue: false });
  });

  describe("list mode (no argument)", () => {
    it("returns 'no previous sessions' when history is empty", async () => {
      const result = await handleResumeCommand(makeParams("/resume", []), true);
      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain("No previous sessions");
    });

    it("lists history entries with date, id prefix, and label", async () => {
      const result = await handleResumeCommand(makeParams("/resume", sampleHistory), true);
      expect(result?.shouldContinue).toBe(false);
      const text = result?.reply?.text ?? "";
      expect(text).toContain("aaaabbb");
      expect(text).toMatch(/Jan(uary)? 15/); // dateFallback: older than 7d shows short date
      expect(text).toContain("chat about TypeScript");
      expect(text).toContain("/resume <id or #>");
    });

    it("limits display to 10 entries", async () => {
      const bigHistory: SessionHistoryEntry[] = Array.from({ length: 15 }, (_, i) => ({
        sessionId: `session-${String(i).padStart(4, "0")}-uuid-longid`,
        updatedAt: Date.now() - i * 1000,
      }));
      const result = await handleResumeCommand(makeParams("/resume", bigHistory), true);
      const text = result?.reply?.text ?? "";
      const matches = text.match(/^\d+\./gm);
      expect(matches?.length).toBe(10);
    });
  });

  describe("resume mode (with argument)", () => {
    it("returns not-found when prefix doesn't match any history entry", async () => {
      const result = await handleResumeCommand(makeParams("/resume xxxxxxxx", sampleHistory), true);
      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain("Session not found");
    });

    it("returns transcript-not-found when no file can be restored", async () => {
      // existsSync returns false (default), readdir returns empty (default)
      const result = await handleResumeCommand(makeParams("/resume aaaabbbb", sampleHistory), true);
      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain("not found on disk");
    });

    it("restores session when transcript exists at known candidate path", async () => {
      vi.mocked(sessionUtilsFs.resolveSessionTranscriptCandidates).mockReturnValueOnce([
        "/tmp/fake/aaaabbbbccccdddd.jsonl",
      ]);
      // First existsSync call returns true (candidate found)
      fsMockState.existsSyncResults = [true];
      vi.mocked(sessions.updateSessionStore).mockResolvedValueOnce(undefined);

      const result = await handleResumeCommand(makeParams("/resume aaaabbbb", sampleHistory), true);
      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain("Resumed session");
      expect(result?.reply?.text).toContain("aaaabbb");
      expect(vi.mocked(sessions.updateSessionStore)).toHaveBeenCalledOnce();
    });

    it("reports not-found when transcript is in external candidate dir but copyFile fails", async () => {
      const externalCand = "/external/sessions/aaaabbbbccccdddd.jsonl";
      vi.mocked(sessionUtilsFs.resolveSessionTranscriptCandidates).mockReturnValueOnce([
        externalCand,
      ]);
      // Candidate exists but is outside sessionsDir (/tmp/fake)
      fsMockState.existsSyncResults = [true];
      fsMockState.copyFileError = Object.assign(new Error("EACCES"), { code: "EACCES" });

      const result = await handleResumeCommand(makeParams("/resume aaaabbbb", sampleHistory), true);
      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain("not found on disk");
      expect(vi.mocked(sessions.updateSessionStore)).not.toHaveBeenCalled();
    });

    it("restores from archive when transcript is missing but .reset.* file exists", async () => {
      const archiveTs = 1700000000000;
      fsMockState.readdirResult = [`aaaabbbbccccdddd.jsonl.reset.${archiveTs}`];
      vi.mocked(sessions.parseSessionArchiveTimestamp).mockReturnValueOnce(archiveTs);
      vi.mocked(sessions.updateSessionStore).mockResolvedValueOnce(undefined);

      const result = await handleResumeCommand(makeParams("/resume aaaabbbb", sampleHistory), true);
      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain("Resumed session");
      expect(fsMockState.renameArgs).toEqual([
        path.join("/tmp/fake", `aaaabbbbccccdddd.jsonl.reset.${archiveTs}`),
        path.join("/tmp/fake", "aaaabbbbccccdddd.jsonl"),
      ]);
    });

    it("restores topic/thread session archive using original filename as prefix", async () => {
      const archiveTs = 1700000000000;
      const topicHistory: SessionHistoryEntry[] = [
        {
          sessionId: "aaaabbbbccccdddd",
          sessionFile: "/tmp/fake/aaaabbbbccccdddd-topic-42.jsonl",
          updatedAt: new Date("2026-01-15T10:00:00Z").getTime(),
          systemSent: true,
        },
      ];
      fsMockState.readdirResult = [`aaaabbbbccccdddd-topic-42.jsonl.reset.${archiveTs}`];
      vi.mocked(sessions.parseSessionArchiveTimestamp).mockReturnValueOnce(archiveTs);
      vi.mocked(sessions.updateSessionStore).mockResolvedValueOnce(undefined);

      const result = await handleResumeCommand(makeParams("/resume aaaabbbb", topicHistory), true);
      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain("Resumed session");
      expect(fsMockState.renameArgs).toEqual([
        path.join("/tmp/fake", `aaaabbbbccccdddd-topic-42.jsonl.reset.${archiveTs}`),
        path.join("/tmp/fake", "aaaabbbbccccdddd-topic-42.jsonl"),
      ]);
    });

    it("finds archive in a candidate directory other than sessionsDir (e.g. legacy sessions dir)", async () => {
      const archiveTs = 1700000000000;
      const legacyDir = "/home/legacy/sessions";
      vi.mocked(sessionUtilsFs.resolveSessionTranscriptCandidates).mockReturnValueOnce([
        "/tmp/fake/aaaabbbbccccdddd.jsonl",
        `${legacyDir}/aaaabbbbccccdddd.jsonl`,
      ]);
      // Both live candidates missing
      fsMockState.existsSyncResults = [false, false];
      // Archive only in the legacy dir
      fsMockState.readdirByDir = new Map([
        ["/tmp/fake", []],
        [legacyDir, [`aaaabbbbccccdddd.jsonl.reset.${archiveTs}`]],
      ]);
      vi.mocked(sessions.parseSessionArchiveTimestamp).mockReturnValueOnce(archiveTs);
      vi.mocked(sessions.updateSessionStore).mockResolvedValueOnce(undefined);

      const result = await handleResumeCommand(makeParams("/resume aaaabbbb", sampleHistory), true);
      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain("Resumed session");
      // Archive from legacy dir should be restored to primary sessionsDir (/tmp/fake)
      expect(fsMockState.renameArgs).toEqual([
        path.join(legacyDir, `aaaabbbbccccdddd.jsonl.reset.${archiveTs}`),
        path.join("/tmp/fake", "aaaabbbbccccdddd.jsonl"),
      ]);
    });

    it("uses copyFile+unlink when cross-device rename (EXDEV) occurs, restoring to primary dir", async () => {
      const archiveTs = 1700000000000;
      const legacyDir = "/home/legacy/sessions";
      vi.mocked(sessionUtilsFs.resolveSessionTranscriptCandidates).mockReturnValueOnce([
        "/tmp/fake/aaaabbbbccccdddd.jsonl",
        `${legacyDir}/aaaabbbbccccdddd.jsonl`,
      ]);
      fsMockState.existsSyncResults = [false, false];
      fsMockState.readdirByDir = new Map([
        ["/tmp/fake", []],
        [legacyDir, [`aaaabbbbccccdddd.jsonl.reset.${archiveTs}`]],
      ]);
      vi.mocked(sessions.parseSessionArchiveTimestamp).mockReturnValueOnce(archiveTs);
      fsMockState.renameError = Object.assign(new Error("EXDEV"), { code: "EXDEV" });
      vi.mocked(sessions.updateSessionStore).mockResolvedValueOnce(undefined);

      const result = await handleResumeCommand(makeParams("/resume aaaabbbb", sampleHistory), true);
      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain("Resumed session");
      // copyFile: archive → primary dir (not legacy dir)
      expect(fsMockState.copyFileArgs).toEqual([
        path.join(legacyDir, `aaaabbbbccccdddd.jsonl.reset.${archiveTs}`),
        path.join("/tmp/fake", "aaaabbbbccccdddd.jsonl"),
      ]);
      // archive removed after successful copy
      expect(fsMockState.unlinkArgs).toBe(
        path.join(legacyDir, `aaaabbbbccccdddd.jsonl.reset.${archiveTs}`),
      );
      // rename was NOT called a second time (no in-place fallback)
      expect(fsMockState.renameArgs).toBeNull();
    });

    it("probes entry.sessionFile directly when candidates normalize it away (e.g. legacy topic transcript)", async () => {
      // candidates only returns the normalized path (no topic suffix) — file doesn't exist there
      vi.mocked(sessionUtilsFs.resolveSessionTranscriptCandidates).mockReturnValueOnce([
        "/tmp/fake/aaaabbbbccccdddd.jsonl",
      ]);
      const legacyTopicHistory: SessionHistoryEntry[] = [
        {
          sessionId: "aaaabbbbccccdddd",
          sessionFile: "/legacy/sessions/aaaabbbbccccdddd-topic-42.jsonl",
          updatedAt: new Date("2026-01-15T10:00:00Z").getTime(),
          systemSent: true,
        },
      ];
      // first existsSync → normalized candidate (false), second → raw sessionFile (true)
      fsMockState.existsSyncResults = [false, true];

      // Use storePath="" (falsy) so updateSessionStore is not called, avoiding the
      // pre-existing barrel-mock issue. The test exercises transcript discovery only.
      const result = await handleResumeCommand(
        makeParams("/resume aaaabbbb", legacyTopicHistory, ""),
        true,
      );
      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain("Resumed session");
      // No sessionsDir (storePath falsy) → raw path returned directly without copying
      expect(fsMockState.copyFileArgs).toBeNull();
    });

    it("prefers entry.sessionFile over normalized candidate in sessionsDir when raw path exists outside candidates (placeholder bug)", async () => {
      // Simulate: normalized candidate exists in primary sessions dir (but is a placeholder),
      // while entry.sessionFile points to the real transcript outside the candidates list.
      vi.mocked(sessionUtilsFs.resolveSessionTranscriptCandidates).mockReturnValueOnce([
        "/tmp/fake/aaaabbbbccccdddd.jsonl",
      ]);
      const legacyTopicHistory: SessionHistoryEntry[] = [
        {
          sessionId: "aaaabbbbccccdddd",
          sessionFile: "/legacy/sessions/aaaabbbbccccdddd-topic-42.jsonl",
          updatedAt: new Date("2026-01-15T10:00:00Z").getTime(),
          systemSent: true,
        },
      ];
      // First existsSync → normalized candidate (true, the placeholder exists),
      // second existsSync → raw sessionFile (true, the real transcript exists).
      fsMockState.existsSyncResults = [true, true];
      vi.mocked(sessions.updateSessionStore).mockResolvedValueOnce(undefined);

      const result = await handleResumeCommand(
        makeParams("/resume aaaabbbb", legacyTopicHistory),
        true,
      );
      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain("Resumed session");
      // Raw path (external) should be copied into primary sessionsDir, not the placeholder returned.
      expect(fsMockState.copyFileArgs).toEqual([
        "/legacy/sessions/aaaabbbbccccdddd-topic-42.jsonl",
        path.join("/tmp/fake", "aaaabbbbccccdddd-topic-42.jsonl"),
      ]);
    });

    it("falls back to normalized candidate when raw sessionFile copy fails (placeholder scenario)", async () => {
      vi.mocked(sessionUtilsFs.resolveSessionTranscriptCandidates).mockReturnValueOnce([
        "/tmp/fake/aaaabbbbccccdddd.jsonl",
      ]);
      const legacyTopicHistory: SessionHistoryEntry[] = [
        {
          sessionId: "aaaabbbbccccdddd",
          sessionFile: "/legacy/sessions/aaaabbbbccccdddd-topic-42.jsonl",
          updatedAt: new Date("2026-01-15T10:00:00Z").getTime(),
          systemSent: true,
        },
      ];
      // Normalized candidate exists, raw path exists but copy will fail.
      fsMockState.existsSyncResults = [true, true];
      fsMockState.copyFileError = Object.assign(new Error("EACCES"), { code: "EACCES" });
      vi.mocked(sessions.updateSessionStore).mockResolvedValueOnce(undefined);

      const result = await handleResumeCommand(
        makeParams("/resume aaaabbbb", legacyTopicHistory),
        true,
      );
      // Should still succeed, falling back to the normalized candidate.
      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain("Resumed session");
    });

    it("resolves session by numeric index (e.g. /resume 1)", async () => {
      vi.mocked(sessionUtilsFs.resolveSessionTranscriptCandidates).mockReturnValueOnce([
        "/tmp/fake/aaaabbbbccccdddd.jsonl",
      ]);
      fsMockState.existsSyncResults = [true];
      vi.mocked(sessions.updateSessionStore).mockResolvedValueOnce(undefined);

      // history[0] is "aaaabbbbccccdddd", so /resume 1 should pick it
      const result = await handleResumeCommand(makeParams("/resume 1", sampleHistory), true);
      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain("Resumed session");
      expect(result?.reply?.text).toContain("aaaabbb");
    });

    it("returns not-found for out-of-range numeric index", async () => {
      const result = await handleResumeCommand(makeParams("/resume 99", sampleHistory), true);
      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain("Session not found");
    });

    it("updates history: removes resumed entry and prepends current session", async () => {
      vi.mocked(sessionUtilsFs.resolveSessionTranscriptCandidates).mockReturnValueOnce([
        "/tmp/fake/aaaabbbbccccdddd.jsonl",
      ]);
      fsMockState.existsSyncResults = [true];

      let capturedStore: Record<string, SessionEntry> = {};
      vi.mocked(sessions.updateSessionStore).mockImplementationOnce(async (_storePath, mutator) => {
        capturedStore = {};
        await mutator(capturedStore);
        return undefined;
      });

      await handleResumeCommand(makeParams("/resume aaaabbbb", sampleHistory), true);

      const updated = capturedStore["telegram:owner"];
      expect(updated).toBeDefined();
      // Resumed entry should NOT be in history
      expect(updated?.history?.find((h) => h.sessionId === "aaaabbbbccccdddd")).toBeUndefined();
      // Current session should be in history
      expect(updated?.history?.find((h) => h.sessionId === "current-session-uuid")).toBeDefined();
    });

    it("clears compaction/flush counters so resumed session is not treated as already flushed", async () => {
      vi.mocked(sessionUtilsFs.resolveSessionTranscriptCandidates).mockReturnValueOnce([
        "/tmp/fake/aaaabbbbccccdddd.jsonl",
      ]);
      fsMockState.existsSyncResults = [true];

      let capturedStore: Record<string, SessionEntry> = {};
      vi.mocked(sessions.updateSessionStore).mockImplementationOnce(async (_storePath, mutator) => {
        // Seed existing entry with compaction state from the outgoing session
        capturedStore = {
          "telegram:owner": {
            sessionId: "current-session-uuid",
            updatedAt: Date.now(),
            compactionCount: 3,
            memoryFlushCompactionCount: 3,
            memoryFlushAt: Date.now() - 1000,
          } as SessionEntry,
        };
        await mutator(capturedStore);
        return undefined;
      });

      await handleResumeCommand(makeParams("/resume aaaabbbb", sampleHistory), true);

      const updated = capturedStore["telegram:owner"];
      expect(updated?.compactionCount).toBe(0);
      expect(updated?.memoryFlushCompactionCount).toBeUndefined();
      expect(updated?.memoryFlushAt).toBeUndefined();
    });

    it("clears cache counters so /status does not show previous session cache usage", async () => {
      vi.mocked(sessionUtilsFs.resolveSessionTranscriptCandidates).mockReturnValueOnce([
        "/tmp/fake/aaaabbbbccccdddd.jsonl",
      ]);
      fsMockState.existsSyncResults = [true];

      let capturedStore: Record<string, SessionEntry> = {};
      vi.mocked(sessions.updateSessionStore).mockImplementationOnce(async (_storePath, mutator) => {
        capturedStore = {
          "telegram:owner": {
            sessionId: "current-session-uuid",
            updatedAt: Date.now(),
            cacheRead: 1234,
            cacheWrite: 567,
            inputTokens: 1000,
            outputTokens: 500,
          } as SessionEntry,
        };
        await mutator(capturedStore);
        return undefined;
      });

      await handleResumeCommand(makeParams("/resume aaaabbbb", sampleHistory), true);

      const updated = capturedStore["telegram:owner"];
      expect(updated?.cacheRead).toBeUndefined();
      expect(updated?.cacheWrite).toBeUndefined();
      expect(updated?.inputTokens).toBeUndefined();
      expect(updated?.outputTokens).toBeUndefined();
    });

    it("clears fallback notice state so resolveFallbackTransition does not emit spurious transitions", async () => {
      vi.mocked(sessionUtilsFs.resolveSessionTranscriptCandidates).mockReturnValueOnce([
        "/tmp/fake/aaaabbbbccccdddd.jsonl",
      ]);
      fsMockState.existsSyncResults = [true];

      let capturedStore: Record<string, SessionEntry> = {};
      vi.mocked(sessions.updateSessionStore).mockImplementationOnce(async (_storePath, mutator) => {
        capturedStore = {
          "telegram:owner": {
            sessionId: "current-session-uuid",
            updatedAt: Date.now(),
            fallbackNoticeSelectedModel: "claude-opus-4-6",
            fallbackNoticeActiveModel: "claude-sonnet-4-6",
            fallbackNoticeReason: "quota",
          } as SessionEntry,
        };
        await mutator(capturedStore);
        return undefined;
      });

      await handleResumeCommand(makeParams("/resume aaaabbbb", sampleHistory), true);

      const updated = capturedStore["telegram:owner"];
      expect(updated?.fallbackNoticeSelectedModel).toBeUndefined();
      expect(updated?.fallbackNoticeActiveModel).toBeUndefined();
      expect(updated?.fallbackNoticeReason).toBeUndefined();
    });

    it("clears abort cutoff fields so the first resumed message is not skipped by shouldSkipMessageByAbortCutoff", async () => {
      vi.mocked(sessionUtilsFs.resolveSessionTranscriptCandidates).mockReturnValueOnce([
        "/tmp/fake/aaaabbbbccccdddd.jsonl",
      ]);
      fsMockState.existsSyncResults = [true];

      let capturedStore: Record<string, SessionEntry> = {};
      vi.mocked(sessions.updateSessionStore).mockImplementationOnce(async (_storePath, mutator) => {
        capturedStore = {
          "telegram:owner": {
            sessionId: "current-session-uuid",
            updatedAt: Date.now(),
            abortCutoffMessageSid: "msg-sid-from-stop",
            abortCutoffTimestamp: Date.now() - 5000,
          } as SessionEntry,
        };
        await mutator(capturedStore);
        return undefined;
      });

      await handleResumeCommand(makeParams("/resume aaaabbbb", sampleHistory), true);

      const updated = capturedStore["telegram:owner"];
      expect(updated?.abortCutoffMessageSid).toBeUndefined();
      expect(updated?.abortCutoffTimestamp).toBeUndefined();
    });

    it("clears systemPromptReport so /context does not show the previous session's report", async () => {
      vi.mocked(sessionUtilsFs.resolveSessionTranscriptCandidates).mockReturnValueOnce([
        "/tmp/fake/aaaabbbbccccdddd.jsonl",
      ]);
      fsMockState.existsSyncResults = [true];

      let capturedStore: Record<string, SessionEntry> = {};
      vi.mocked(sessions.updateSessionStore).mockImplementationOnce(async (_storePath, mutator) => {
        capturedStore = {
          "telegram:owner": {
            sessionId: "current-session-uuid",
            updatedAt: Date.now(),
            systemPromptReport: { source: "run", generatedAt: Date.now() } as SessionEntry["systemPromptReport"],
          } as SessionEntry,
        };
        await mutator(capturedStore);
        return undefined;
      });

      await handleResumeCommand(makeParams("/resume aaaabbbb", sampleHistory), true);

      expect(capturedStore["telegram:owner"]?.systemPromptReport).toBeUndefined();
    });
  });
});
