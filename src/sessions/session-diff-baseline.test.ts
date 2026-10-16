import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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

function baseline(sessionId: string): SessionDiffBaseline {
  return {
    version: 1,
    sessionId,
    root: "/workspace",
    files: [],
  };
}

function makeEntry(
  sessionId: string,
  fields: Partial<InternalSessionEntry> = {},
): InternalSessionEntry {
  return { createdVia: "operator", sessionId, updatedAt: Date.now(), ...fields };
}

async function seedEntry(
  entry: InternalSessionEntry,
  agentId = "main",
  sessionKey = "agent:main:diff-owner",
) {
  const dir = sessionDirs.make();
  const storePath = path.join(dir, "sessions.json");
  await replaceSessionEntry({ agentId, sessionKey, storePath }, entry);
  return { agentId, entry, sessionKey, storePath };
}

function ensure(target: Awaited<ReturnType<typeof seedEntry>>, isNewSession = false) {
  return ensureSessionDiffBaseline({ ...target, cwd: "/workspace", isNewSession });
}

function loadInternal(sessionKey: string, storePath: string): InternalSessionEntry | undefined {
  return loadSessionEntry({ sessionKey, storePath }) as InternalSessionEntry | undefined;
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

describe("ensureSessionDiffBaseline", () => {
  beforeEach(() => {
    captureMocks.capture.mockReset();
    persistenceMocks.patch.mockReset();
    persistenceMocks.patch.mockImplementation((...args) => {
      if (!persistenceMocks.actualPatch) {
        throw new Error("missing actual session entry patcher");
      }
      return persistenceMocks.actualPatch(...args);
    });
  });

  it.each([false, true])(
    "keeps a global session baseline in its selected agent's custom store (new=%s)",
    async (isNewSession) => {
      const entry = makeEntry("work-global-session", {
        sessionDiffBaselineCapture: isNewSession
          ? undefined
          : createSessionDiffBaselineCaptureClaim(),
        updatedAt: 2,
      });
      const target = await seedEntry(entry, "work", "global");
      const mainScope = { agentId: "main", sessionKey: "global", storePath: target.storePath };
      await replaceSessionEntry(mainScope, { sessionId: "main-global-session", updatedAt: 1 });
      const mainBefore = loadSessionEntry(mainScope);
      captureMocks.capture.mockResolvedValue(baseline(entry.sessionId));

      const sql = observeHostDataSql();
      const settled = await ensure(target, isNewSession).finally(sql.restore);

      expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
      expect(settled.sessionDiffBaseline).toEqual(baseline(entry.sessionId));
      const persisted = loadSessionEntry(target);
      expect(persisted).toMatchObject({
        sessionId: entry.sessionId,
        sessionDiffBaseline: baseline(entry.sessionId),
      });
      expect(persisted?.sessionDiffBaselineCapture).toBeUndefined();
      expect(loadSessionEntry(mainScope)).toEqual(mainBefore);
    },
  );

  it.each([true, false])("shares a capture with a concurrent caller (new=%s)", async (isNew) => {
    const sessionId = "concurrent-session";
    const entry = makeEntry(sessionId);
    const target = await seedEntry(entry);
    const capture = deferCapture();

    const first = ensure(target, true);
    const second = ensure(target, isNew);
    try {
      await capture.started;
      expect(captureMocks.capture).toHaveBeenCalledTimes(1);
      capture.resolve(baseline(sessionId));

      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(captureMocks.capture).toHaveBeenCalledTimes(1);
      expect(firstResult.sessionDiffBaseline).toEqual(baseline(sessionId));
      expect(secondResult.sessionDiffBaseline).toEqual(baseline(sessionId));
    } finally {
      capture.resolve(baseline(sessionId));
      await Promise.allSettled([first, second]);
    }
  });

  it("returns a terminal unavailable entry after capture failure and never retries it", async () => {
    const sessionId = "failed-session";
    const entry = makeEntry(sessionId, {
      sessionDiffBaselineCapture: createSessionDiffBaselineCaptureClaim(),
    });
    const target = await seedEntry(entry);
    captureMocks.capture.mockRejectedValue(new Error("capture failed"));

    const settled = await ensure(target);
    expect(settled.sessionDiffBaselineCapture).toMatchObject({ status: "unavailable" });
    const unavailable = loadInternal(target.sessionKey, target.storePath);
    expect(unavailable?.sessionDiffBaselineCapture).toMatchObject({ status: "unavailable" });
    if (!unavailable) {
      throw new Error("expected unavailable capture marker");
    }

    await expect(ensure({ ...target, entry: unavailable })).resolves.toEqual(unavailable);
    expect(captureMocks.capture).toHaveBeenCalledTimes(1);
    captureMocks.capture.mockResolvedValue(baseline(sessionId));
    await expect(ensure(target)).resolves.toEqual(unavailable);
    expect(loadInternal(target.sessionKey, target.storePath)?.sessionDiffBaseline).toBeUndefined();
  });

  it.each([
    ["captured baseline", false],
    ["terminal unavailable", true],
  ] as const)("fails closed when persisting %s fails", async (_label, captureFails) => {
    const sessionId = `settlement-failure-${captureFails ? "unavailable" : "baseline"}`;
    const claim = createSessionDiffBaselineCaptureClaim();
    const entry = makeEntry(sessionId, {
      sessionDiffBaselineCapture: claim,
    });
    const target = await seedEntry(entry);
    if (captureFails) {
      captureMocks.capture.mockRejectedValueOnce(new Error("capture failed"));
    } else {
      captureMocks.capture.mockResolvedValueOnce(baseline(sessionId));
    }
    persistenceMocks.patch.mockRejectedValueOnce(new Error("settlement write failed"));

    await expect(ensure(target)).rejects.toMatchObject({
      code: "SESSION_WORK_START_INVALIDATED",
      message: expect.stringMatching(/could not persist its diff baseline/i),
    });
    expect(loadInternal(target.sessionKey, target.storePath)).toMatchObject({
      sessionDiffBaselineCapture: claim,
    });
  });

  it("preserves an existing work-start invalidation from settlement persistence", async () => {
    const sessionId = "settlement-invalidation";
    const entry = makeEntry(sessionId, {
      sessionDiffBaselineCapture: createSessionDiffBaselineCaptureClaim(),
    });
    const target = await seedEntry(entry);
    const invalidation = new SessionWorkStartInvalidatedError(
      "session reset while persisting baseline",
    );
    captureMocks.capture.mockResolvedValueOnce(baseline(sessionId));
    persistenceMocks.patch.mockRejectedValueOnce(invalidation);

    await expect(ensure(target)).rejects.toBe(invalidation);
    expect(loadInternal(target.sessionKey, target.storePath)).toMatchObject({
      sessionDiffBaselineCapture: entry.sessionDiffBaselineCapture,
    });
  });

  it("does not retroactively capture a legacy existing session", async () => {
    const entry = makeEntry("legacy-session");
    const target = await seedEntry(entry);

    await expect(ensure(target)).resolves.toEqual(entry);
    expect(captureMocks.capture).not.toHaveBeenCalled();
    expect(loadInternal(target.sessionKey, target.storePath)).toMatchObject(entry);
    expect(loadInternal(target.sessionKey, target.storePath)).not.toHaveProperty(
      "sessionDiffBaselineCapture",
    );
  });

  it("invalidates capture completion after the authoritative row is deleted", async () => {
    const sessionId = "deleted-during-capture";
    const entry = makeEntry(sessionId, {
      sessionDiffBaselineCapture: createSessionDiffBaselineCaptureClaim(),
    });
    const target = await seedEntry(entry);
    const capture = deferCapture();
    const completion = ensure(target);
    const outcome = expect(completion).rejects.toMatchObject({
      code: "SESSION_WORK_START_CHANGED",
      message: expect.stringMatching(/was deleted while starting work/i),
    });
    await capture.started;
    expect(captureMocks.capture).toHaveBeenCalledOnce();
    await deleteSessionEntryLifecycle({
      archiveTranscript: false,
      storePath: target.storePath,
      target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
    });
    capture.resolve(baseline(sessionId));

    await outcome;
    expect(loadInternal(target.sessionKey, target.storePath)).toBeUndefined();
  });
});
