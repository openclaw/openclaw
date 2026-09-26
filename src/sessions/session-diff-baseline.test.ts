import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SessionWorkStartInvalidatedError } from "../config/sessions/lifecycle.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { createSessionDiffBaselineCaptureClaim } from "../config/sessions/session-diff-baseline-capture.js";
import type { InternalSessionEntry, SessionDiffBaseline } from "../config/sessions/types.js";
import { createDeferredCore } from "../shared/deferred.js";

type CaptureSessionDiffBaseline =
  (typeof import("./session-diff.js"))["captureSessionDiffBaseline"];
type PatchSessionEntryCore =
  (typeof import("../config/sessions/session-accessor.js"))["patchSessionEntryCore"];
type LoadSessionEntryReadOnly =
  (typeof import("../config/sessions/session-accessor.js"))["loadSessionEntryReadOnly"];

const captureMocks = vi.hoisted(() => ({
  capture: vi.fn<CaptureSessionDiffBaseline>(),
}));
const persistenceMocks = vi.hoisted(() => ({
  actualRead: undefined as LoadSessionEntryReadOnly | undefined,
  actualPatch: undefined as PatchSessionEntryCore | undefined,
  read: vi.fn<LoadSessionEntryReadOnly>(),
  patch: vi.fn<PatchSessionEntryCore>(),
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  persistenceMocks.actualRead = actual.loadSessionEntryReadOnly;
  persistenceMocks.actualPatch = actual.patchSessionEntryCore;
  return {
    ...actual,
    loadSessionEntryReadOnly: persistenceMocks.read,
    patchSessionEntryCore: persistenceMocks.patch,
  };
});

vi.mock("./session-diff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-diff.js")>()),
  captureSessionDiffBaseline: captureMocks.capture,
}));

import { ensureSessionDiffBaseline } from "./session-diff-baseline.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

async function seedEntry(params: {
  entry: InternalSessionEntry;
  sessionKey?: string;
  agentId?: string;
}): Promise<{
  agentId: string;
  entry: InternalSessionEntry;
  sessionKey: string;
  storePath: string;
}> {
  const dir = tempDirs.make("openclaw-session-diff-owner-");
  const storePath = path.join(dir, "sessions.json");
  const agentId = params.agentId ?? "main";
  const sessionKey = params.sessionKey ?? "agent:main:diff-owner";
  await replaceSessionEntry({ agentId, sessionKey, storePath }, params.entry);
  return { agentId, entry: params.entry, sessionKey, storePath };
}

function ensure(target: Awaited<ReturnType<typeof seedEntry>>, isNewSession = false) {
  return ensureSessionDiffBaseline({ ...target, cwd: "/workspace", isNewSession });
}

function loadInternal(sessionKey: string, storePath: string): InternalSessionEntry | undefined {
  return loadSessionEntry({ sessionKey, storePath }) as InternalSessionEntry | undefined;
}

function expectWorkStartError(
  result: PromiseSettledResult<unknown>,
  message: RegExp,
  code: "SESSION_WORK_START_CHANGED" | "SESSION_WORK_START_INVALIDATED",
): void {
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") {
    expect(result.reason).toMatchObject({ code });
    expect(String(result.reason)).toMatch(message);
  }
}

describe("ensureSessionDiffBaseline", () => {
  beforeEach(() => {
    captureMocks.capture.mockReset();
    persistenceMocks.read.mockReset();
    persistenceMocks.patch.mockReset();
    persistenceMocks.read.mockImplementation((...args) => {
      if (!persistenceMocks.actualRead) {
        throw new Error("missing actual session entry loader");
      }
      return persistenceMocks.actualRead(...args);
    });
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
      const entry: InternalSessionEntry = {
        createdVia: "operator",
        sessionId: "work-global-session",
        sessionDiffBaselineCapture: isNewSession
          ? undefined
          : createSessionDiffBaselineCaptureClaim(),
        updatedAt: 2,
      };
      const target = await seedEntry({ agentId: "work", sessionKey: "global", entry });
      const mainScope = { agentId: "main", sessionKey: "global", storePath: target.storePath };
      await replaceSessionEntry(mainScope, { sessionId: "main-global-session", updatedAt: 1 });
      const mainBefore = loadSessionEntry(mainScope);
      captureMocks.capture.mockResolvedValue(baseline(entry.sessionId));

      const settled = await ensureSessionDiffBaseline({
        ...target,
        cwd: "/workspace",
        isNewSession,
      });

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

  it("shares one capture across concurrent first-turn ensures", async () => {
    const sessionId = "concurrent-session";
    const entry = makeEntry(sessionId);
    const target = await seedEntry({ entry });
    const capture = createDeferredCore<SessionDiffBaseline>();
    captureMocks.capture.mockReturnValue(capture.promise);

    const first = ensure(target, true);
    const second = ensure(target, true);
    await vi.waitFor(() => expect(captureMocks.capture).toHaveBeenCalledTimes(1));
    capture.resolve(baseline(sessionId));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.sessionDiffBaseline).toEqual(baseline(sessionId));
    expect(secondResult.sessionDiffBaseline).toEqual(baseline(sessionId));
  });

  it("rejects a stale cached baseline after the authoritative generation rotates", async () => {
    const sessionId = "stale-cached-settled";
    const cachedEntry = makeEntry(sessionId, {
      lifecycleRevision: "cached-generation",
      sessionDiffBaseline: baseline(sessionId),
    });
    const target = await seedEntry({ entry: cachedEntry });
    const freshClaim = createSessionDiffBaselineCaptureClaim();
    await replaceSessionEntry(
      { sessionKey: target.sessionKey, storePath: target.storePath },
      {
        ...cachedEntry,
        lifecycleRevision: "fresh-generation",
        sessionDiffBaseline: undefined,
        sessionDiffBaselineCapture: freshClaim,
      },
    );

    await expect(ensure(target)).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
    expect(captureMocks.capture).not.toHaveBeenCalled();
    expect(loadInternal(target.sessionKey, target.storePath)).toMatchObject({
      lifecycleRevision: "fresh-generation",
      sessionDiffBaselineCapture: freshClaim,
    });
  });

  it("settles an authoritative pending claim instead of returning a stale cached baseline", async () => {
    const sessionId = "same-generation-stale-settled";
    const cachedEntry = makeEntry(sessionId, {
      lifecycleRevision: "shared-generation",
      sessionDiffBaseline: baseline(sessionId),
    });
    const target = await seedEntry({ entry: cachedEntry });
    const pendingClaim = createSessionDiffBaselineCaptureClaim();
    await replaceSessionEntry(
      { sessionKey: target.sessionKey, storePath: target.storePath },
      {
        ...cachedEntry,
        sessionDiffBaseline: undefined,
        sessionDiffBaselineCapture: pendingClaim,
      },
    );
    const authoritativeBaseline = { ...baseline(sessionId), root: "/authoritative" };
    captureMocks.capture.mockResolvedValue(authoritativeBaseline);

    const settled = await ensure(target);
    expect(settled.sessionDiffBaseline).toEqual(authoritativeBaseline);
    expect(settled.sessionDiffBaselineCapture).toBeUndefined();
    expect(captureMocks.capture).toHaveBeenCalledOnce();
    expect(loadInternal(target.sessionKey, target.storePath)).toMatchObject({
      lifecycleRevision: "shared-generation",
      sessionDiffBaseline: authoritativeBaseline,
    });
    expect(
      loadInternal(target.sessionKey, target.storePath)?.sessionDiffBaselineCapture,
    ).toBeUndefined();
  });

  it("fails closed when the authoritative generation read fails", async () => {
    const sessionId = "settled-read-failure";
    const entry = makeEntry(sessionId, {
      lifecycleRevision: "read-failure-generation",
      sessionDiffBaseline: baseline(sessionId),
    });
    const target = await seedEntry({ entry });
    persistenceMocks.read.mockImplementationOnce(() => {
      throw new Error("authoritative read failed");
    });

    await expect(ensure(target)).rejects.toMatchObject({ code: "SESSION_WORK_START_INVALIDATED" });
    expect(captureMocks.capture).not.toHaveBeenCalled();
  });

  it("returns a terminal unavailable entry after capture failure and never retries it", async () => {
    const sessionId = "failed-session";
    const entry = makeEntry(sessionId, {
      sessionDiffBaselineCapture: createSessionDiffBaselineCaptureClaim(),
    });
    const target = await seedEntry({ entry });
    captureMocks.capture.mockRejectedValue(new Error("capture failed"));

    const settled = await ensure(target);
    expect(settled.sessionDiffBaselineCapture).toMatchObject({ status: "unavailable" });
    const unavailable = loadInternal(target.sessionKey, target.storePath);
    expect(unavailable?.sessionDiffBaselineCapture).toMatchObject({
      status: "unavailable",
    });
    if (!unavailable) {
      throw new Error("expected unavailable capture marker");
    }

    await expect(ensure({ ...target, entry: unavailable })).resolves.toEqual(unavailable);
    expect(captureMocks.capture).toHaveBeenCalledTimes(1);
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
    const target = await seedEntry({ entry });
    if (captureFails) {
      captureMocks.capture.mockRejectedValueOnce(new Error("capture failed"));
    } else {
      captureMocks.capture.mockResolvedValueOnce(baseline(sessionId));
    }
    persistenceMocks.patch.mockRejectedValueOnce(new Error("settlement write failed"));

    const [settled] = await Promise.allSettled([ensure(target)]);
    if (!settled) {
      throw new Error("expected capture settlement");
    }
    expectWorkStartError(
      settled,
      /could not persist its diff baseline/i,
      "SESSION_WORK_START_INVALIDATED",
    );
    expect(loadInternal(target.sessionKey, target.storePath)).toMatchObject({
      sessionDiffBaselineCapture: claim,
    });
  });

  it("preserves an existing work-start invalidation from settlement persistence", async () => {
    const sessionId = "settlement-invalidation";
    const entry = makeEntry(sessionId, {
      sessionDiffBaselineCapture: createSessionDiffBaselineCaptureClaim(),
    });
    const target = await seedEntry({ entry });
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
    const target = await seedEntry({ entry });

    const authoritative = loadInternal(target.sessionKey, target.storePath);
    await expect(ensure(target)).resolves.toEqual(authoritative);
    expect(captureMocks.capture).not.toHaveBeenCalled();
    expect(loadInternal(target.sessionKey, target.storePath)).toMatchObject(entry);
    expect(loadInternal(target.sessionKey, target.storePath)).not.toHaveProperty(
      "sessionDiffBaselineCapture",
    );
  });

  it("rejects claim arming before mutating a replacement lifecycle generation", async () => {
    const sessionId = "replacement-before-arm";
    const entry = makeEntry(sessionId, {
      lifecycleRevision: "old-generation",
    });
    const target = await seedEntry({ entry });
    persistenceMocks.patch.mockImplementationOnce(async (...args) => {
      await replaceSessionEntry(
        { sessionKey: target.sessionKey, storePath: target.storePath },
        { ...entry, lifecycleRevision: "replacement-generation" },
      );
      if (!persistenceMocks.actualPatch) {
        throw new Error("missing actual session entry patcher");
      }
      return await persistenceMocks.actualPatch(...args);
    });

    await expect(ensure(target, true)).rejects.toMatchObject({
      code: "SESSION_WORK_START_CHANGED",
    });
    expect(loadInternal(target.sessionKey, target.storePath)).toMatchObject({
      lifecycleRevision: "replacement-generation",
      sessionId,
    });
    expect(loadInternal(target.sessionKey, target.storePath)?.sessionDiffBaselineCapture).toBe(
      undefined,
    );
    expect(captureMocks.capture).not.toHaveBeenCalled();
  });

  it("invalidates claim arming when the authoritative row is missing", async () => {
    const entry = makeEntry("deleted-before-arm");
    const storePath = path.join(tempDirs.make("openclaw-session-diff-missing-"), "sessions.json");

    const result = await Promise.allSettled([
      ensure(
        { agentId: "main", entry, sessionKey: "agent:main:missing-before-arm", storePath },
        true,
      ),
    ]);

    const [settled] = result;
    if (!settled) {
      throw new Error("expected claim-arm settlement");
    }
    expectWorkStartError(settled, /was deleted while starting work/i, "SESSION_WORK_START_CHANGED");
    expect(captureMocks.capture).not.toHaveBeenCalled();
  });

  it("invalidates capture completion after the authoritative row is deleted", async () => {
    const sessionId = "deleted-during-capture";
    const entry = makeEntry(sessionId, {
      sessionDiffBaselineCapture: createSessionDiffBaselineCaptureClaim(),
    });
    const target = await seedEntry({ entry });
    const capture = createDeferredCore<SessionDiffBaseline>();
    captureMocks.capture.mockReturnValue(capture.promise);
    const completion = ensure(target);
    const outcome = Promise.allSettled([completion]);
    await vi.waitFor(() => expect(captureMocks.capture).toHaveBeenCalledOnce());
    await deleteSessionEntryLifecycle({
      archiveTranscript: false,
      storePath: target.storePath,
      target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
    });
    capture.resolve(baseline(sessionId));

    const [settled] = await outcome;
    if (!settled) {
      throw new Error("expected capture settlement");
    }
    expectWorkStartError(settled, /was deleted while starting work/i, "SESSION_WORK_START_CHANGED");
    expect(loadInternal(target.sessionKey, target.storePath)).toBeUndefined();
  });

  it("rejects an old completion after the same session id receives a fresh claim", async () => {
    const sessionId = "same-session-id";
    const oldClaim = createSessionDiffBaselineCaptureClaim();
    const entry = makeEntry(sessionId, {
      sessionDiffBaselineCapture: oldClaim,
    });
    const target = await seedEntry({ entry });
    const capture = createDeferredCore<SessionDiffBaseline>();
    captureMocks.capture.mockReturnValue(capture.promise);
    const oldCompletions = [ensure(target), ensure(target)];
    const outcomes = Promise.allSettled(oldCompletions);
    await vi.waitFor(() => expect(captureMocks.capture).toHaveBeenCalledTimes(1));

    const freshClaim = createSessionDiffBaselineCaptureClaim();
    await replaceSessionEntry(
      { sessionKey: target.sessionKey, storePath: target.storePath },
      { ...entry, lifecycleRevision: "fresh-generation", sessionDiffBaselineCapture: freshClaim },
    );
    capture.resolve(baseline(sessionId));
    for (const result of await outcomes) {
      expectWorkStartError(result, /changed while starting work/i, "SESSION_WORK_START_CHANGED");
    }

    expect(loadInternal(target.sessionKey, target.storePath)).toMatchObject({
      lifecycleRevision: "fresh-generation",
      sessionDiffBaselineCapture: freshClaim,
    });
    expect(loadInternal(target.sessionKey, target.storePath)?.sessionDiffBaseline).toBeUndefined();
  });

  it("rejects an old completion before mutating a same-claim replacement generation", async () => {
    const sessionId = "same-claim-replacement";
    const claim = createSessionDiffBaselineCaptureClaim();
    const entry = makeEntry(sessionId, {
      lifecycleRevision: "old-generation",
      sessionDiffBaselineCapture: claim,
    });
    const target = await seedEntry({ entry });
    const capture = createDeferredCore<SessionDiffBaseline>();
    captureMocks.capture.mockReturnValue(capture.promise);
    const completion = ensure(target);
    const outcome = Promise.allSettled([completion]);
    await vi.waitFor(() => expect(captureMocks.capture).toHaveBeenCalledOnce());

    await replaceSessionEntry(
      { sessionKey: target.sessionKey, storePath: target.storePath },
      { ...entry, lifecycleRevision: "replacement-generation" },
    );
    capture.resolve(baseline(sessionId));

    const [settled] = await outcome;
    if (!settled) {
      throw new Error("expected capture settlement");
    }
    expectWorkStartError(settled, /changed while starting work/i, "SESSION_WORK_START_CHANGED");
    expect(loadInternal(target.sessionKey, target.storePath)).toMatchObject({
      lifecycleRevision: "replacement-generation",
      sessionDiffBaselineCapture: claim,
    });
    expect(loadInternal(target.sessionKey, target.storePath)?.sessionDiffBaseline).toBeUndefined();
  });
});
