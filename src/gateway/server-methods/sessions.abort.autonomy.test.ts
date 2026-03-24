import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testState, writeSessionStore } from "../test-helpers.js";
import { sessionsHandlers } from "./sessions.js";

const queueCleanupMocks = vi.hoisted(() => ({
  clearSessionQueues: vi.fn<
    () => {
      followupCleared: number;
      laneCleared: number;
      keys: string[];
    }
  >(() => ({ followupCleared: 0, laneCleared: 0, keys: [] })),
}));

const abortMocks = vi.hoisted(() => ({
  stopSubagentsForRequester: vi.fn(() => ({ stopped: 0 })),
}));

const acpManagerMocks = vi.hoisted(() => ({
  cancelSession: vi.fn(async () => {}),
}));

vi.mock("../../auto-reply/reply/queue/cleanup.js", async () => {
  const actual = await vi.importActual<typeof import("../../auto-reply/reply/queue/cleanup.js")>(
    "../../auto-reply/reply/queue/cleanup.js",
  );
  return {
    ...actual,
    clearSessionQueues: queueCleanupMocks.clearSessionQueues,
  };
});

vi.mock("../../auto-reply/reply/abort.js", async () => {
  const actual = await vi.importActual<typeof import("../../auto-reply/reply/abort.js")>(
    "../../auto-reply/reply/abort.js",
  );
  return {
    ...actual,
    stopSubagentsForRequester: abortMocks.stopSubagentsForRequester,
  };
});

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    cancelSession: acpManagerMocks.cancelSession,
  }),
}));

describe("sessions.abort autonomy stop", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-abort-autonomy-"));
    testState.sessionStorePath = path.join(tempDir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });
    queueCleanupMocks.clearSessionQueues.mockReset().mockReturnValue({
      followupCleared: 2,
      laneCleared: 1,
      keys: ["main", "agent:main:main", "sess-main"],
    });
    abortMocks.stopSubagentsForRequester.mockReset().mockReturnValue({ stopped: 1 });
    acpManagerMocks.cancelSession.mockClear();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("disables session-bound cron jobs and reports stopped session work", async () => {
    const respond = vi.fn();
    const cronUpdate = vi.fn(async () => ({}));

    await sessionsHandlers["sessions.abort"]({
      req: { id: "req-sessions-abort-autonomy" } as never,
      params: { key: "main" },
      respond,
      context: {
        chatAbortControllers: new Map(),
        getSessionEventSubscriberConnIds: () => new Set(),
        broadcastToConnIds: vi.fn(),
        cron: {
          list: vi.fn(async () => [
            {
              id: "job-bound",
              enabled: true,
              sessionTarget: "session:agent:main:main",
              sessionKey: "agent:main:main",
            },
            {
              id: "job-other",
              enabled: true,
              sessionTarget: "isolated",
              sessionKey: "cron:job-other",
            },
          ]),
          update: cronUpdate,
        },
        logGateway: { warn: vi.fn() },
      } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(cronUpdate).toHaveBeenCalledWith("job-bound", { enabled: false });
    expect(abortMocks.stopSubagentsForRequester).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      requesterSessionKey: "agent:main:main",
    });
    expect(queueCleanupMocks.clearSessionQueues).toHaveBeenCalledWith(["main", "agent:main:main"]);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        status: "stopped",
        stopped: true,
        stoppedSubagents: 1,
        clearedFollowups: 2,
        clearedCommands: 1,
        disabledCronJobIds: ["job-bound"],
        disabledCronJobs: 1,
      }),
      undefined,
      undefined,
    );
  });
});
