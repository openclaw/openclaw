/**
 * thread-participants.test.ts
 *
 * [목적]
 * 스레드 참여자 레지스트리의 동작을 검증한다.
 * 멀티 에이전트 환경에서 특정 스레드에 어떤 봇이 참여하고 있는지 추적하는 모듈이다.
 *
 * [배경]
 * message-handler.preflight.ts의 thread guard가 이 레지스트리를 사용하여
 * "이 스레드에 이미 참여 중인 봇만 응답" 로직을 구현한다.
 * 레지스트리가 잘못 동작하면 봇이 관계없는 스레드에 침입하거나,
 * 참여해야 할 스레드에서 응답하지 않는 문제가 발생한다.
 *
 * [upstream merge 시 주의]
 * - 참여자 저장 구조(Map/Set)가 변경되면 중복 등록, 독립성 테스트 확인 필요
 * - TTL/만료 로직이 변경되면 cleanupExpiredThreads 테스트 업데이트 필요
 * - 디스크 영속화 로직 회귀는 아래 "thread participants state path"에서 검증
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import {
  clearThreadParticipants,
  cleanupExpiredThreads,
  getThreadParticipants,
  hasThreadParticipants,
  isThreadParticipant,
  registerThreadParticipant,
  registerThreadParticipants,
  touchThreadActivity,
} from "./thread-participants.js";

type ThreadParticipantsModule = typeof import("./thread-participants.js");

const THREAD_PARTICIPANTS_STATE_KEY = "__openclaw_threadParticipants__";

let envSnapshot: ReturnType<typeof captureEnv>;
let originalCwd = process.cwd();
const tempDirs: string[] = [];

function resetThreadParticipantsRuntime(): void {
  const runtimeGlobal = globalThis as Record<string, unknown>;
  delete runtimeGlobal[THREAD_PARTICIPANTS_STATE_KEY];
}

async function loadThreadParticipantsModule(tag: string): Promise<ThreadParticipantsModule> {
  return (await import(
    /* @vite-ignore */ `./thread-participants.ts?thread-participants-test=${tag}`
  )) as ThreadParticipantsModule;
}

function createEntry(threadId: string, participants: string[]) {
  const now = Date.now();
  return {
    threadId,
    participants,
    createdAt: now,
    lastActivityAt: now,
  };
}

async function writeStore(
  filePath: string,
  entries: Record<
    string,
    {
      threadId: string;
      participants: string[];
      createdAt: number;
      lastActivityAt: number;
    }
  >,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        version: 1,
        threads: entries,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

async function createRuntimeLayout() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-thread-participants-"));
  tempDirs.push(base);
  const homeDir = path.join(base, "home");
  const repoDir = path.join(base, "repo");
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(path.join(repoDir, "state"), { recursive: true });
  return {
    homeDir,
    repoDir,
    sharedStatePath: path.join(homeDir, ".openclaw", "state", "thread-participants.json"),
    legacyCwdStatePath: path.join(repoDir, "state", "thread-participants.json"),
    legacyWorkspaceStatePath: path.join(
      homeDir,
      ".openclaw",
      "workspace-seum",
      "state",
      "thread-participants.json",
    ),
  };
}

beforeEach(() => {
  envSnapshot = captureEnv(["HOME", "OPENCLAW_STATE_DIR", "CLAWDBOT_STATE_DIR"]);
  originalCwd = process.cwd();
  resetThreadParticipantsRuntime();
});

afterEach(() => {
  clearThreadParticipants();
});

afterEach(async () => {
  vi.useRealTimers();
  process.chdir(originalCwd);
  envSnapshot.restore();
  resetThreadParticipantsRuntime();
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => await fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("thread-participants", () => {
  const THREAD_A = "thread-aaa";
  const THREAD_B = "thread-bbb";
  const BOT_1 = "bot-111";
  const BOT_2 = "bot-222";
  const BOT_3 = "bot-333";

  describe("registerThreadParticipant", () => {
    it("registers a bot as participant in a thread", () => {
      registerThreadParticipant(THREAD_A, BOT_1);
      expect(isThreadParticipant(THREAD_A, BOT_1)).toBe(true);
    });

    it("does not duplicate participants on repeated registration", () => {
      registerThreadParticipant(THREAD_A, BOT_1);
      registerThreadParticipant(THREAD_A, BOT_1);
      registerThreadParticipant(THREAD_A, BOT_1);
      expect(getThreadParticipants(THREAD_A)).toEqual([BOT_1]);
    });

    it("registers multiple bots in the same thread", () => {
      registerThreadParticipant(THREAD_A, BOT_1);
      registerThreadParticipant(THREAD_A, BOT_2);
      const participants = getThreadParticipants(THREAD_A);
      expect(participants).toContain(BOT_1);
      expect(participants).toContain(BOT_2);
      expect(participants).toHaveLength(2);
    });

    it("keeps threads independent", () => {
      registerThreadParticipant(THREAD_A, BOT_1);
      registerThreadParticipant(THREAD_B, BOT_2);
      expect(isThreadParticipant(THREAD_A, BOT_1)).toBe(true);
      expect(isThreadParticipant(THREAD_A, BOT_2)).toBe(false);
      expect(isThreadParticipant(THREAD_B, BOT_2)).toBe(true);
      expect(isThreadParticipant(THREAD_B, BOT_1)).toBe(false);
    });
  });

  describe("registerThreadParticipants (batch)", () => {
    it("registers multiple bots at once", () => {
      registerThreadParticipants(THREAD_A, [BOT_1, BOT_2, BOT_3]);
      expect(getThreadParticipants(THREAD_A)).toEqual([BOT_1, BOT_2, BOT_3]);
    });
  });

  describe("isThreadParticipant", () => {
    it("returns false for unknown thread", () => {
      expect(isThreadParticipant("nonexistent", BOT_1)).toBe(false);
    });

    it("returns false for non-participant bot", () => {
      registerThreadParticipant(THREAD_A, BOT_1);
      expect(isThreadParticipant(THREAD_A, BOT_2)).toBe(false);
    });
  });

  describe("hasThreadParticipants", () => {
    it("returns false for unknown thread", () => {
      expect(hasThreadParticipants("nonexistent")).toBe(false);
    });

    it("returns true when thread has participants", () => {
      registerThreadParticipant(THREAD_A, BOT_1);
      expect(hasThreadParticipants(THREAD_A)).toBe(true);
    });
  });

  describe("getThreadParticipants", () => {
    it("returns empty array for unknown thread", () => {
      expect(getThreadParticipants("nonexistent")).toEqual([]);
    });

    it("returns a copy (not a reference to internal state)", () => {
      registerThreadParticipant(THREAD_A, BOT_1);
      const list = getThreadParticipants(THREAD_A);
      list.push("injected");
      expect(getThreadParticipants(THREAD_A)).toEqual([BOT_1]);
    });
  });

  describe("touchThreadActivity", () => {
    it("does not throw for unknown thread", () => {
      expect(() => touchThreadActivity("nonexistent")).not.toThrow();
    });

    it("updates activity without changing participants", () => {
      registerThreadParticipant(THREAD_A, BOT_1);
      touchThreadActivity(THREAD_A);
      expect(getThreadParticipants(THREAD_A)).toEqual([BOT_1]);
    });
  });

  describe("clearThreadParticipants", () => {
    it("removes all threads", () => {
      registerThreadParticipant(THREAD_A, BOT_1);
      registerThreadParticipant(THREAD_B, BOT_2);
      clearThreadParticipants();
      expect(isThreadParticipant(THREAD_A, BOT_1)).toBe(false);
      expect(isThreadParticipant(THREAD_B, BOT_2)).toBe(false);
    });
  });

  describe("cleanupExpiredThreads", () => {
    it("returns 0 when no threads are expired", () => {
      registerThreadParticipant(THREAD_A, BOT_1);
      expect(cleanupExpiredThreads()).toBe(0);
      expect(isThreadParticipant(THREAD_A, BOT_1)).toBe(true);
    });
  });
});

describe("thread participants state path", () => {
  it("loads shared state and backfills legacy cwd-local participants into it", async () => {
    const layout = await createRuntimeLayout();
    process.env.HOME = layout.homeDir;
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.CLAWDBOT_STATE_DIR;
    process.chdir(layout.repoDir);

    await writeStore(layout.sharedStatePath, {
      "thread-shared": createEntry("thread-shared", ["bot-shared"]),
    });
    await writeStore(layout.legacyCwdStatePath, {
      "thread-legacy": createEntry("thread-legacy", ["bot-legacy"]),
    });

    const participants = await loadThreadParticipantsModule("loads-shared-state");
    participants.loadThreadParticipants();

    expect(participants.isThreadParticipant("thread-shared", "bot-shared")).toBe(true);
    expect(participants.isThreadParticipant("thread-legacy", "bot-legacy")).toBe(true);

    const sharedStore = JSON.parse(await fs.readFile(layout.sharedStatePath, "utf-8")) as {
      threads: Record<string, { participants: string[] }>;
    };
    expect(sharedStore.threads["thread-shared"]?.participants).toEqual(["bot-shared"]);
    expect(sharedStore.threads["thread-legacy"]?.participants).toEqual(["bot-legacy"]);
  });

  it("persists participants under shared OpenClaw state instead of cwd-local state", async () => {
    const layout = await createRuntimeLayout();
    process.env.HOME = layout.homeDir;
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.CLAWDBOT_STATE_DIR;
    process.chdir(layout.repoDir);
    vi.useFakeTimers();

    await writeStore(layout.legacyCwdStatePath, {});

    const participants = await loadThreadParticipantsModule("writes-shared-state");
    participants.registerThreadParticipant("thread-shared", "bot-shared");
    await vi.advanceTimersByTimeAsync(1_000);

    const sharedStore = JSON.parse(await fs.readFile(layout.sharedStatePath, "utf-8")) as {
      threads: Record<string, { participants: string[] }>;
    };
    const legacyStore = JSON.parse(await fs.readFile(layout.legacyCwdStatePath, "utf-8")) as {
      threads: Record<string, { participants: string[] }>;
    };

    expect(sharedStore.threads["thread-shared"]?.participants).toEqual(["bot-shared"]);
    expect(legacyStore.threads["thread-shared"]).toBeUndefined();
  });

  it("imports legacy workspace-scoped participants into shared OpenClaw state", async () => {
    const layout = await createRuntimeLayout();
    process.env.HOME = layout.homeDir;
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.CLAWDBOT_STATE_DIR;
    process.chdir(layout.repoDir);

    await writeStore(layout.legacyWorkspaceStatePath, {
      "thread-workspace": createEntry("thread-workspace", ["bot-workspace"]),
    });

    const participants = await loadThreadParticipantsModule("imports-workspace-state");
    participants.loadThreadParticipants();

    expect(participants.isThreadParticipant("thread-workspace", "bot-workspace")).toBe(true);

    const sharedStore = JSON.parse(await fs.readFile(layout.sharedStatePath, "utf-8")) as {
      threads: Record<string, { participants: string[] }>;
    };
    expect(sharedStore.threads["thread-workspace"]?.participants).toEqual(["bot-workspace"]);
  });
});
