import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";

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

afterEach(async () => {
  vi.useRealTimers();
  process.chdir(originalCwd);
  envSnapshot.restore();
  resetThreadParticipantsRuntime();
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => await fs.rm(dir, { recursive: true, force: true })),
  );
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
