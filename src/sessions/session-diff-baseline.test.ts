import path from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { SessionWorkStartInvalidatedError } from "../config/sessions/lifecycle.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { createSessionDiffBaselineCaptureClaim } from "../config/sessions/session-diff-baseline-capture.js";
import type { InternalSessionEntry, SessionDiffBaseline } from "../config/sessions/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";

type CaptureSessionDiffBaseline =
  (typeof import("./session-diff.js"))["captureSessionDiffBaseline"];
type PatchSessionEntryCore =
  (typeof import("../config/sessions/session-accessor.js"))["patchSessionEntryCore"];
const captureMocks = vi.hoisted(() => ({
  capture: vi.fn<CaptureSessionDiffBaseline>(),
}));
const persistenceMocks = vi.hoisted(() => ({
  actualPatch: undefined as PatchSessionEntryCore | undefined,
  patch: vi.fn<PatchSessionEntryCore>(),
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  persistenceMocks.actualPatch = actual.patchSessionEntryCore;
  return {
    ...actual,
    patchSessionEntryCore: persistenceMocks.patch,
  };
});

vi.mock("./session-diff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-diff.js")>()),
  captureSessionDiffBaseline: captureMocks.capture,
}));

import { ensureSessionDiffBaseline } from "./session-diff-baseline.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-diff-owner-");

const sessionId = "diff-session";
const baseline = (): SessionDiffBaseline => ({
  version: 1,
  sessionId,
  root: "/workspace",
  files: [],
});

async function fixture(claim = true, agentId = "main", sessionKey = "agent:main:diff-owner") {
  const entry: InternalSessionEntry = {
    createdVia: "operator",
    sessionId,
    updatedAt: Date.now(),
    ...(claim ? { sessionDiffBaselineCapture: createSessionDiffBaselineCaptureClaim() } : {}),
  };
  const target = { agentId, sessionKey, storePath: path.join(sessionDirs.make(), "sessions.json") };
  await replaceSessionEntry(target, entry);
  return {
    entry,
    target,
    read: () => loadSessionEntry(target) as InternalSessionEntry | undefined,
    run: (isNewSession = false, current = entry) =>
      ensureSessionDiffBaseline({ ...target, entry: current, cwd: "/workspace", isNewSession }),
  };
}

function deferCapture() {
  const started = createDeferredCore();
  const capture = createDeferredCore<SessionDiffBaseline>();
  captureMocks.capture.mockImplementation(() => {
    started.resolve();
    return capture.promise;
  });
  return { started: started.promise, resolve: capture.resolve };
}

beforeEach(() => {
  captureMocks.capture.mockReset();
  persistenceMocks.patch.mockReset().mockImplementation((...args) => {
    if (!persistenceMocks.actualPatch) {
      throw new Error("missing actual session entry patcher");
    }
    return persistenceMocks.actualPatch(...args);
  });
});

it.each([false, true])(
  "keeps a global session baseline in its selected agent's custom store (new=%s)",
  async (isNewSession) => {
    const f = await fixture(!isNewSession, "work", "global");
    const { entry, target } = f;
    const mainScope = { agentId: "main", sessionKey: "global", storePath: target.storePath };
    await replaceSessionEntry(mainScope, { sessionId: "main-global-session", updatedAt: 1 });
    const mainBefore = loadSessionEntry(mainScope);
    captureMocks.capture.mockResolvedValue(baseline());

    const sql = observeHostDataSql();
    const settled = await f.run(isNewSession).finally(sql.restore);

    expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
    expect(settled.sessionDiffBaseline).toEqual(baseline());
    const persisted = loadSessionEntry(target);
    expect(persisted).toMatchObject({
      sessionId: entry.sessionId,
      sessionDiffBaseline: baseline(),
    });
    expect(persisted?.sessionDiffBaselineCapture).toBeUndefined();
    expect(loadSessionEntry(mainScope)).toEqual(mainBefore);
  },
);

it.each([true, false])("shares a capture with a concurrent caller (new=%s)", async (isNew) => {
  const f = await fixture(false);
  const capture = deferCapture();

  const first = f.run(true);
  const second = f.run(isNew);
  try {
    await capture.started;
    expect(captureMocks.capture).toHaveBeenCalledTimes(1);
    capture.resolve(baseline());

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(captureMocks.capture).toHaveBeenCalledTimes(1);
    expect([firstResult.sessionDiffBaseline, secondResult.sessionDiffBaseline]).toEqual([
      baseline(),
      baseline(),
    ]);
  } finally {
    capture.resolve(baseline());
    await Promise.allSettled([first, second]);
  }
});

it("returns a terminal unavailable entry after capture failure and never retries it", async () => {
  const f = await fixture();
  captureMocks.capture.mockRejectedValue(new Error("capture failed"));

  const settled = await f.run();
  expect(settled.sessionDiffBaselineCapture).toMatchObject({ status: "unavailable" });
  const unavailable = f.read();
  expect(unavailable?.sessionDiffBaselineCapture).toMatchObject({ status: "unavailable" });
  if (!unavailable) {
    throw new Error("expected unavailable capture marker");
  }

  await expect(f.run(false, unavailable)).resolves.toEqual(unavailable);
  expect(captureMocks.capture).toHaveBeenCalledTimes(1);
  captureMocks.capture.mockResolvedValue(baseline());
  await expect(f.run()).resolves.toEqual(unavailable);
  expect(f.read()?.sessionDiffBaseline).toBeUndefined();
});

it.each([
  ["captured baseline", false, false],
  ["terminal unavailable", true, false],
  ["existing invalidation", false, true],
] as const)(
  "fails closed when persisting %s fails",
  async (_label, captureFails, preserveError) => {
    const f = await fixture();
    const claim = f.entry.sessionDiffBaselineCapture;
    if (captureFails) {
      captureMocks.capture.mockRejectedValueOnce(new Error("capture failed"));
    } else {
      captureMocks.capture.mockResolvedValueOnce(baseline());
    }
    const error = preserveError
      ? new SessionWorkStartInvalidatedError("session reset while persisting baseline")
      : new Error("settlement write failed");
    persistenceMocks.patch.mockRejectedValueOnce(error);
    if (preserveError) {
      await expect(f.run()).rejects.toBe(error);
    } else {
      await expect(f.run()).rejects.toMatchObject({
        code: "SESSION_WORK_START_INVALIDATED",
        message: expect.stringMatching(/could not persist its diff baseline/i),
      });
    }
    expect(f.read()).toMatchObject({ sessionDiffBaselineCapture: claim });
  },
);

it("does not retroactively capture a legacy existing session", async () => {
  const f = await fixture(false);
  const { entry } = f;

  await expect(f.run()).resolves.toEqual(entry);
  expect(captureMocks.capture).not.toHaveBeenCalled();
  expect(f.read()).toMatchObject(entry);
  expect(f.read()).not.toHaveProperty("sessionDiffBaselineCapture");
});

it("invalidates capture completion after the authoritative row is deleted", async () => {
  const f = await fixture();
  const capture = deferCapture();
  const completion = f.run();
  const outcome = expect(completion).rejects.toMatchObject({
    code: "SESSION_WORK_START_CHANGED",
    message: expect.stringMatching(/was deleted while starting work/i),
  });
  await capture.started;
  expect(captureMocks.capture).toHaveBeenCalledOnce();
  await deleteSessionEntryLifecycle({
    archiveTranscript: false,
    storePath: f.target.storePath,
    target: { canonicalKey: f.target.sessionKey, storeKeys: [f.target.sessionKey] },
  });
  capture.resolve(baseline());

  await outcome;
  expect(f.read()).toBeUndefined();
});
