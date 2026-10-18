import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { disposeAllSessionMcpRuntimes } from "../../agents/agent-bundle-mcp-manager-api.js";
import type { OpenClawConfig } from "../../config/config.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import {
  bindSessionControllerTarget,
  captureSessionTarget,
  isSessionMutationActive,
} from "../../sessions/session-controller.lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { enqueueFollowupRun, getFollowupQueueDepth } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearSessionQueues } from "./queue/cleanup.js";
import {
  initSessionState,
  writeSessionStore as writeSessionStoreFast,
} from "./test/session.test-support.js";

vi.mock("../../plugin-sdk/browser-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugin-sdk/browser-maintenance.js")>()),
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
}));

vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/hook-runner-global.js")>()),
  getGlobalHookRunner: () => null,
}));

let suiteRoot = "";
let suiteCase = 0;

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-rollover-preemption-"));
});

afterAll(async () => {
  await fs.rm(suiteRoot, { recursive: true, force: true });
});

afterEach(async () => {
  vi.useRealTimers();
  await disposeAllSessionMcpRuntimes();
  await closeOpenClawStateDatabaseAsync();
});

async function makeStorePath(): Promise<string> {
  const dir = path.join(suiteRoot, String(++suiteCase));
  await fs.mkdir(dir);
  return path.join(dir, "sessions.json");
}

it("preempts a running turn and cancels two queued follow-ups before /new resets", async () => {
  const storePath = await makeStorePath();
  const sessionKey = "agent:main:telegram:dm:rollover-admission";
  const sessionId = "session-before-admitted-rollover";
  const transcriptPath = path.join(path.dirname(storePath), `${sessionId}.jsonl`);
  await writeSessionStoreFast(storePath, {
    [sessionKey]: { sessionId, updatedAt: Date.now() },
  });
  await fs.writeFile(transcriptPath, '{"type":"message"}\n', "utf8");

  const target = captureSessionTarget({
    storeScope: storePath,
    sessionKey,
    aliases: [sessionId],
    incarnation: sessionId,
    agentId: "main",
  });
  const runStarted = createDeferred();
  let runInterrupted = false;
  const activeRun = withSessionTurn(
    { sessionKey, sessionId, target },
    async (_operation, signal) => {
      runStarted.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          runInterrupted = true;
          resolve();
        });
      });
    },
  );
  await runStarted.promise;
  for (const prompt of ["first waiting follow-up", "second waiting follow-up"]) {
    const queued = createQueueTestRun({ prompt });
    queued.run = {
      ...queued.run,
      sessionKey,
      sessionId,
      agentId: "main",
      config: { session: { store: storePath } } as OpenClawConfig,
    };
    expect(
      enqueueFollowupRun(
        sessionKey,
        queued,
        { mode: "followup", debounceMs: 60_000 },
        "none",
        undefined,
        false,
      ),
    ).toBe(true);
  }
  expect(getFollowupQueueDepth(sessionKey)).toBe(2);
  const initialization = initSessionState({
    ctx: {
      Body: "/new",
      RawBody: "/new",
      CommandBody: "/new",
      From: "user-rollover-admission",
      To: "bot",
      ChatType: "direct",
      SessionKey: sessionKey,
      Provider: "telegram",
      Surface: "telegram",
    },
    cfg: { session: { store: storePath, idleMinutes: 999 } } as OpenClawConfig,
  });

  try {
    const result = await initialization;
    await activeRun;
    expect(runInterrupted).toBe(true);
    expect(result).toMatchObject({ sessionId, resetTriggered: true });
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expect(await fs.stat(transcriptPath).catch(() => null)).not.toBeNull();
  } finally {
    clearSessionQueues([sessionKey, sessionId]);
    await initialization.catch(() => {});
    await activeRun.catch(() => {});
  }
});

it("preserves the rollover timeout error when /new preemption does not settle", async () => {
  const storePath = await makeStorePath();
  const sessionKey = "agent:main:telegram:dm:rollover-timeout";
  const sessionId = "session-before-timeout-rollover";
  await writeSessionStoreFast(storePath, {
    [sessionKey]: { sessionId, updatedAt: Date.now() },
  });
  const target = captureSessionTarget({
    storeScope: storePath,
    sessionKey,
    aliases: [sessionId],
    incarnation: sessionId,
    agentId: "main",
  });
  const operation = createReplyOperation({
    sessionKey,
    sessionId,
    target,
    resetTriggered: false,
  });
  bindSessionControllerTarget(operation, target);
  const preemptAttempted = createDeferred();
  vi.spyOn(operation, "abort").mockImplementation(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    preemptAttempted.resolve();
    return false;
  });
  const initialization = initSessionState({
    ctx: {
      Body: "/new",
      RawBody: "/new",
      CommandBody: "/new",
      From: "user-rollover-timeout",
      To: "bot",
      ChatType: "direct",
      SessionKey: sessionKey,
      Provider: "telegram",
      Surface: "telegram",
    },
    cfg: { session: { store: storePath, idleMinutes: 999 } } as OpenClawConfig,
  });
  void initialization.catch(() => {});
  try {
    await preemptAttempted.promise;
    expect(isSessionMutationActive(storePath, target.aliases)).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    vi.useRealTimers();

    await expect(initialization).rejects.toThrow(
      `timed out draining work before reply session rollover: ${sessionKey}`,
    );
  } finally {
    operation.complete();
    await initialization.catch(() => undefined);
  }
});
