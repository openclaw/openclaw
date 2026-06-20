/**
 * Exercises the sessions-echo add/remove/list commands against a REAL temp
 * session store. The commands resolve their store path directly from
 * `opts.store`, patch the on-disk session entry via patchSessionEntry, and
 * round-trip echoTargets through JSON, so these tests assert the persisted
 * store after each command rather than mocking the store layer.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readSessionStoreForTest,
  useTempSessionsFixture,
  writeSessionStoreForTest,
} from "../config/sessions/test-helpers.js";
import type { SessionEchoTarget, SessionEntry } from "../config/sessions/types.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  sessionsEchoAddCommand,
  sessionsEchoListCommand,
  sessionsEchoRemoveCommand,
} from "./sessions-echo.js";

const SESSION_KEY = "test-echo-session";
// The session participant: a thread bound to this session. targetMatchesSessionParticipant
// matches an add against lastChannel/lastTo/lastAccountId/lastThreadId.
const PARTICIPANT_CHANNEL = "telegram";
const PARTICIPANT_TO = "12345";

const fixture = useTempSessionsFixture("sessions-echo-test-");

type CapturedRuntime = RuntimeEnv & {
  logs: string[];
  errors: string[];
  exitCodes: number[];
  json: () => unknown;
};

function createRuntime(): CapturedRuntime {
  const logs: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  let jsonValue: unknown;
  let sawJson = false;
  return {
    logs,
    errors,
    exitCodes,
    json: () => (sawJson ? jsonValue : undefined),
    log: (...args: unknown[]) => {
      const text = args.map((a) => String(a)).join(" ");
      logs.push(text);
      // commands emit JSON via runtime.log(JSON.stringify(...)) on the base RuntimeEnv.
      try {
        jsonValue = JSON.parse(text);
        sawJson = true;
      } catch {
        // not a JSON line; ignore
      }
    },
    error: (...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    },
    exit: (code: number) => {
      exitCodes.push(code);
    },
  };
}

function seedStore(echoTargets?: SessionEchoTarget[]): void {
  const entry: Partial<SessionEntry> = {
    sessionId: "session-id-1",
    updatedAt: Date.now(),
    // Participant fields read by targetMatchesSessionParticipant.
    channel: PARTICIPANT_CHANNEL,
    lastChannel: PARTICIPANT_CHANNEL,
    lastTo: PARTICIPANT_TO,
    ...(echoTargets ? { echoTargets } : {}),
  };
  writeSessionStoreForTest(fixture.storePath(), { [SESSION_KEY]: entry });
}

function makeTarget(to: string, label?: string): SessionEchoTarget {
  return {
    channel: PARTICIPANT_CHANNEL,
    to,
    label,
    addedAt: 1,
  };
}

function addOpts(overrides: { to: string; label?: string }) {
  return {
    sessionKey: SESSION_KEY,
    store: fixture.storePath(),
    channel: PARTICIPANT_CHANNEL,
    to: overrides.to,
    label: overrides.label,
    echoUser: true,
    echoAssistant: true,
    json: true,
  };
}

function persistedTargets(): SessionEchoTarget[] {
  const store = readSessionStoreForTest(fixture.storePath());
  return store[SESSION_KEY]?.echoTargets ?? [];
}

beforeEach(() => {
  seedStore();
});

afterEach(() => {
  // fixture afterEach removes the temp dir; nothing extra needed here.
});

describe("sessionsEchoAddCommand", () => {
  it("adds a participant target so echoTargets gains it (changed)", async () => {
    const runtime = createRuntime();
    await sessionsEchoAddCommand(addOpts({ to: PARTICIPANT_TO, label: "self" }), runtime);

    expect(runtime.exitCodes).toEqual([]);
    expect(runtime.json()).toMatchObject({ ok: true, added: true });

    const targets = persistedTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ channel: PARTICIPANT_CHANNEL, to: PARTICIPANT_TO });
  });

  it("treats a duplicate add as a no-op without duplicating the target", async () => {
    seedStore([makeTarget(PARTICIPANT_TO)]);
    const runtime = createRuntime();
    await sessionsEchoAddCommand(addOpts({ to: PARTICIPANT_TO }), runtime);

    expect(runtime.exitCodes).toEqual([]);
    expect(runtime.json()).toMatchObject({ ok: true, added: false });
    expect(persistedTargets()).toHaveLength(1);
  });

  it("rejects an add at the 16-target cap with the atLimit error", async () => {
    // Fill to MAX_ECHO_TARGETS (16) with distinct participant-matching targets.
    // Self-match only requires same channel+to+account+thread; "to" must equal
    // PARTICIPANT_TO to pass participant check, so vary threadId to keep them
    // distinct while still matching the (threadless) participant is impossible —
    // instead vary "to" but pre-seed them directly (participant check only runs
    // on the NEW target being added, not the pre-existing list).
    const existing = Array.from({ length: 16 }, (_, i) => makeTarget(`pre-${i}`));
    seedStore(existing);
    const runtime = createRuntime();
    await sessionsEchoAddCommand(addOpts({ to: PARTICIPANT_TO }), runtime);

    expect(runtime.exitCodes).toEqual([1]);
    expect(runtime.json()).toMatchObject({ ok: false, added: false });
    // No new target was appended; still at the cap.
    expect(persistedTargets()).toHaveLength(16);
  });

  it("rejects a non-participant target (notParticipant)", async () => {
    const runtime = createRuntime();
    await sessionsEchoAddCommand(addOpts({ to: "99999" }), runtime);

    expect(runtime.exitCodes).toEqual([1]);
    expect(runtime.json()).toMatchObject({ ok: false, added: false });
    expect(persistedTargets()).toHaveLength(0);
  });
});

describe("sessionsEchoRemoveCommand", () => {
  it("removes the last target so the echoTargets field is dropped", async () => {
    seedStore([makeTarget(PARTICIPANT_TO)]);
    const runtime = createRuntime();
    await sessionsEchoRemoveCommand(
      {
        sessionKey: SESSION_KEY,
        store: fixture.storePath(),
        channel: PARTICIPANT_CHANNEL,
        to: PARTICIPANT_TO,
        json: true,
      },
      runtime,
    );

    expect(runtime.exitCodes).toEqual([]);
    expect(runtime.json()).toMatchObject({ ok: true, removed: true, echoTargets: [] });

    // After removing the last target the persisted entry has no echoTargets.
    const store = readSessionStoreForTest(fixture.storePath());
    expect(store[SESSION_KEY]?.echoTargets ?? []).toEqual([]);
  });

  it("treats removing a non-existent target as a no-op", async () => {
    seedStore([makeTarget(PARTICIPANT_TO)]);
    const runtime = createRuntime();
    await sessionsEchoRemoveCommand(
      {
        sessionKey: SESSION_KEY,
        store: fixture.storePath(),
        channel: PARTICIPANT_CHANNEL,
        to: "does-not-exist",
        json: true,
      },
      runtime,
    );

    expect(runtime.exitCodes).toEqual([]);
    expect(runtime.json()).toMatchObject({ ok: true, removed: false });
    // The pre-existing target survives the no-op remove.
    const targets = persistedTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ to: PARTICIPANT_TO });
  });
});

describe("sessionsEchoListCommand", () => {
  it("lists the current echo targets", async () => {
    const seeded = [makeTarget(PARTICIPANT_TO, "self"), makeTarget("67890", "other")];
    seedStore(seeded);
    const runtime = createRuntime();
    await sessionsEchoListCommand(
      { sessionKey: SESSION_KEY, store: fixture.storePath(), json: true },
      runtime,
    );

    expect(runtime.exitCodes).toEqual([]);
    const out = runtime.json() as { sessionKey: string; echoTargets: SessionEchoTarget[] };
    expect(out.sessionKey).toBe(SESSION_KEY);
    expect(out.echoTargets.map((t) => t.to)).toEqual([PARTICIPANT_TO, "67890"]);
  });
});
