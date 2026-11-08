import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildTuiLastSessionScopeKey, writeTuiLastSessionKey } from "./tui-last-session.js";
import {
  disposeActiveTuiFixtures,
  objectFieldEquals,
  readFixtureLog,
  startTuiFixture,
  waitForSynchronizedFrameRows,
  type FixtureLogEntry,
} from "./tui-pty-harness-fixture-test-support.js";
const STARTUP_TIMEOUT_MS = 60_000;
const REMEMBERED_SESSION_KEY = "agent:main:picker-target";
const SESSION_SCOPE_KEY = buildTuiLastSessionScopeKey({
  connectionUrl: "pty-fixture://local",
  agentId: "main",
  sessionScope: "per-sender",
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Fixture = Awaited<ReturnType<typeof createFixture>>;
async function createFixture(options?: Parameters<typeof startTuiFixture>[0]) {
  const fixture = await startTuiFixture(options);
  return {
    ...fixture,
    write: (text: string) => fixture.run.write(text, { delay: false }),
    output: (text: string, timeout = STARTUP_TIMEOUT_MS) =>
      fixture.run.waitForOutput(text, timeout),
    containing: (...texts: string[]) =>
      waitForSynchronizedFrameRows(
        fixture.run,
        (frame) => texts.every((text) => frame.some((row) => row.includes(text))),
        STARTUP_TIMEOUT_MS,
      ),
    rows: (predicate: (rows: string[]) => boolean, timeout = STARTUP_TIMEOUT_MS) =>
      waitForSynchronizedFrameRows(fixture.run, predicate, timeout),
    call: (method: string, signal: AbortSignal, field?: string, value?: unknown) =>
      fixture.waitForLogEntry(
        (entry) =>
          entry.method === method &&
          (field === undefined || objectFieldEquals(entry, field, value)),
        signal,
      ),
  };
}
async function withFixture(fixture: Fixture, body: () => Promise<void>) {
  try {
    await body();
  } finally {
    await fixture.cleanup();
  }
}
async function sendTo(fixture: Fixture, signal: AbortSignal, message: string, sessionKey: string) {
  await fixture.write(`${message}\r`);
  const sent = await fixture.call("sendChat", signal, "message", message);
  expect(sent.payload).toMatchObject({ sessionKey });
}
function sessionFixture(
  stateDir: string,
  env: NodeJS.ProcessEnv = {},
  options: Parameters<typeof startTuiFixture>[0] = {},
) {
  return createFixture({
    ...options,
    env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1", ...env },
  });
}
async function expectPendingPreview(fixture: Fixture, signal: AbortSignal) {
  await fixture.call("sessionDescriptionPending", signal, "sessionKey", REMEMBERED_SESSION_KEY);
  const rows = await fixture.rows(
    (frame) =>
      frame.some((row) => row.includes("session picker-target")) &&
      !frame.some((row) => row.includes("session main")),
    8_000,
  );
  expect(rows.join("\n")).toContain("session picker-target");
  expect(await readFixtureLog(fixture.logPath)).not.toContainEqual(
    expect.objectContaining({ method: "sessionDescriptionReleased" }),
  );
}

async function seedRememberedSession(
  stateDir: string,
  sessionKey: string = REMEMBERED_SESSION_KEY,
) {
  await writeTuiLastSessionKey({
    scopeKey: SESSION_SCOPE_KEY,
    sessionKey,
    stateDir,
  });
}
async function waitForLogCount(
  fixture: Fixture,
  signal: AbortSignal,
  predicate: (entry: FixtureLogEntry) => boolean,
  count: number,
) {
  const matches = new Set<number>();
  await fixture.waitForLogEntry((entry, index) => {
    if (predicate(entry)) {
      matches.add(index);
    }
    return matches.size >= count;
  }, signal);
  return await readFixtureLog(fixture.logPath);
}
function markerSends(entries: FixtureLogEntry[], marker: string) {
  return entries.filter(
    (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
  );
}
afterEach(disposeActiveTuiFixtures);
it("previews and restores the exact remembered session behind six newer prefix and label matches", async ({
  signal,
}) => {
  const stateDir = tempDirs.make("openclaw-tui-exact-description-");
  await seedRememberedSession(stateDir);
  const fixture = await sessionFixture(
    stateDir,
    { OPENCLAW_TUI_PTY_DECOY_COUNT: "6" },
    { holdSessionDescription: true },
  );
  await withFixture(fixture, async () => {
    await expectPendingPreview(fixture, signal);
    await fixture.releaseStartup();
    const rows = await fixture.containing("local ready");
    expect(rows.join("\n")).toContain("session picker-target");
    expect(rows.join("\n")).not.toContain("session main");
    await sendTo(fixture, signal, "exact restore proof", REMEMBERED_SESSION_KEY);
  });
}, 65_000);
it("hides a stale approval when startup restores the remembered session", async ({ signal }) => {
  const stateDir = tempDirs.make("openclaw-tui-identity-");
  await seedRememberedSession(stateDir);
  const fixture = await sessionFixture(stateDir, {
    OPENCLAW_TUI_PTY_INITIAL_APPROVAL_SESSION_KEY: "agent:main:main",
  });
  await withFixture(fixture, async () => {
    await fixture.call("loadHistory", signal, "sessionKey", REMEMBERED_SESSION_KEY);
    await fixture.call("listPluginApprovals", signal, "pending", true);
    const rows = await fixture.containing("session picker-target", "local ready");
    expect(rows.join("\n")).not.toContain("plugin approval");
  });
}, 65_000);
it.for<{
  phase: "global alias" | "startup history" | "reconnect history" | "stale restore generation";
  sessionKey: string;
  env: NodeJS.ProcessEnv;
}>([
  {
    phase: "global alias",
    sessionKey: "agent:main:main",
    env: {
      OPENCLAW_TUI_PTY_PICKER_SESSION_KEY: "global",
      OPENCLAW_TUI_PTY_MAIN_SESSION_KEY: "agent:main:main",
    },
  },
  {
    phase: "startup history",
    sessionKey: REMEMBERED_SESSION_KEY,
    env: { OPENCLAW_TUI_PTY_STARTUP_DELAY_MS: "400" },
  },
  {
    phase: "reconnect history",
    sessionKey: REMEMBERED_SESSION_KEY,
    env: {
      OPENCLAW_TUI_PTY_DISCONNECT_REASON: "fixture transport loss",
      OPENCLAW_TUI_PTY_RECONNECT_HISTORY_DELAY_MS: "400",
    },
  },
  {
    phase: "stale restore generation",
    sessionKey: REMEMBERED_SESSION_KEY,
    env: {
      OPENCLAW_TUI_PTY_RECONNECT_DURING_RESTORE: "1",
      OPENCLAW_TUI_PTY_RESTORE_DELAY_MS: "400",
    },
  },
])(
  "keeps input editable without sending until $phase resolves",
  { timeout: 65_000 },
  async ({ phase, sessionKey, env }, { signal }) => {
    const stateDir = tempDirs.make("openclaw-tui-input-admission-");
    const marker = `${phase} input proof`;
    await seedRememberedSession(
      stateDir,
      phase === "global alias" ? "global" : REMEMBERED_SESSION_KEY,
    );
    const fixture = await createFixture({
      holdStartupHistory: phase === "global alias",
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
        ...env,
      },
    });
    await withFixture(fixture, async () => {
      if (phase === "reconnect history") {
        await fixture.output("local ready");
        await fixture.write("/gateway-status\r");
        await fixture.call("reconnectHistoryPending", signal);
      } else if (phase === "stale restore generation") {
        await fixture.call("restoreReconnect", signal);
        await waitForLogCount(
          fixture,
          signal,
          (entry) =>
            entry.method === "describeSession" &&
            objectFieldEquals(entry, "sessionKey", sessionKey),
          2,
        );
      } else {
        await fixture.waitForLogEntry(
          (entry) =>
            entry.method === (phase === "global alias" ? "startupHistoryPending" : "loadHistory") &&
            objectFieldEquals(entry, "sessionKey", sessionKey),
          signal,
        );
      }
      await fixture.write(`${marker}\r`);
      await fixture.output("local runtime not ready — message not sent");
      expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toEqual([]);
      await fixture.releaseStartup();
      const readyMarkers =
        phase === "reconnect history"
          ? ["gateway reconnected after transport loss", marker]
          : [`session ${sessionKey.split(":").at(-1)}`, "local ready", marker];
      const rows = await fixture.containing(...readyMarkers);
      expect(rows.join("\n")).toContain(marker);
      expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(0);
      await fixture.write("\r");
      const sent = await fixture.call("sendChat", signal, "message", marker);
      expect(sent.payload).toMatchObject({ sessionKey });
      expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(1);
    });
  },
);
it.for([{ failInitialHistory: true }])(
  "handles literal initial messages when startup history failure is $failInitialHistory",
  { timeout: 65_000 },
  async ({ failInitialHistory }, { signal }) => {
    const initialMessage = "!literal initial message";
    const fixture = await createFixture({
      failInitialHistory,
      env: {
        OPENCLAW_STATE_DIR: tempDirs.make("openclaw-tui-initial-message-"),
        OPENCLAW_TUI_PTY_SESSION: REMEMBERED_SESSION_KEY,
        OPENCLAW_TUI_PTY_INITIAL_MESSAGE: initialMessage,
      },
    });
    await withFixture(fixture, async () => {
      await fixture.call("initialHistoryFailed", signal);
      await fixture.output("initial message not sent — retry it after the session is ready");
      expect(markerSends(await readFixtureLog(fixture.logPath), initialMessage)).toEqual([]);
      await fixture.write(`/session ${REMEMBERED_SESSION_KEY}\r`);
      await waitForLogCount(
        fixture,
        signal,
        (entry) =>
          entry.method === "loadHistory" &&
          objectFieldEquals(entry, "sessionKey", REMEMBERED_SESSION_KEY),
        2,
      );
      await fixture.rows((rows) =>
        rows.some((row) => row.trim() === `session ${REMEMBERED_SESSION_KEY}`),
      );
      expect(markerSends(await readFixtureLog(fixture.logPath), initialMessage)).toEqual([]);
      const explicitMessage = "explicit message after history recovery";
      await fixture.write(`${explicitMessage}\r`);
      const sent = await fixture.call("sendChat", signal, "message", explicitMessage);
      expect(sent.payload).toMatchObject({
        sessionKey: REMEMBERED_SESSION_KEY,
        message: explicitMessage,
      });
      await fixture.output(`PTY_RESPONSE: ${explicitMessage}`);
      const entries = await readFixtureLog(fixture.logPath);
      expect(markerSends(entries, initialMessage)).toEqual([]);
      expect(markerSends(entries, explicitMessage)).toHaveLength(1);
    });
  },
);
it("keeps an explicit launch session authoritative over remembered state", async ({ signal }) => {
  const stateDir = tempDirs.make("openclaw-tui-explicit-session-");
  const explicitSession = "agent:main:explicit-target";
  const marker = "explicit startup session proof";
  await seedRememberedSession(stateDir);
  const fixture = await sessionFixture(stateDir, {
    OPENCLAW_TUI_PTY_SESSION: explicitSession,
    OPENCLAW_TUI_PTY_DELIVER: "1",
  });
  await withFixture(fixture, async () => {
    await fixture.output("session explicit-target");
    await fixture.output("local ready");
    await sendTo(fixture, signal, marker, explicitSession);
    expect(markerSends(await readFixtureLog(fixture.logPath), marker)[0]?.payload).toMatchObject({
      deliver: true,
    });
    const entries = await readFixtureLog(fixture.logPath);
    expect(
      entries.some((entry) => objectFieldEquals(entry, "sessionKey", REMEMBERED_SESSION_KEY)),
    ).toBe(false);
    expect(markerSends(entries, marker)).toHaveLength(1);
  });
}, 65_000);
it("clears the provisional label after a remembered lookup error and retries on reconnect", async ({
  signal,
}) => {
  const stateDir = tempDirs.make("openclaw-tui-restore-failure-");
  const marker = "restore failure fallback proof";
  await seedRememberedSession(stateDir);
  const fixture = await sessionFixture(
    stateDir,
    {
      OPENCLAW_TUI_PTY_RESTORE_FAILURES: "1",
      OPENCLAW_TUI_PTY_DISCONNECT_REASON: "fixture restore lookup retry",
    },
    { holdSessionDescription: true },
  );
  await withFixture(fixture, async () => {
    await expectPendingPreview(fixture, signal);
    await fixture.releaseStartup();
    // After fallback the header/footer must agree with the send target, not
    // retain the stale provisional label.
    const rows = await fixture.containing("local ready");
    expect(rows.join("\n")).toContain("session main");
    expect(rows.join("\n")).not.toContain("session picker-target");
    await sendTo(fixture, signal, marker, "main");
    expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(1);
    await fixture.output(`PTY_RESPONSE: ${marker}`);
    // Another TUI can replace the scoped pointer after fallback. A transient
    // validation error must leave the next connection eligible to restore it.
    await seedRememberedSession(stateDir);
    await fixture.write("/gateway-status\r");
    await fixture.call("disconnect", signal);
    await fixture.containing("local ready", "session picker-target");
    const retryMarker = "restore lookup retry proof";
    await sendTo(fixture, signal, retryMarker, REMEMBERED_SESSION_KEY);
    expect(markerSends(await readFixtureLog(fixture.logPath), retryMarker)).toHaveLength(1);
  });
}, 65_000);
it.for([
  { choice: "different", selectedKey: "agent:main:mode-target", steps: ["agent:main:mode-target"] },
  {
    choice: "return to original",
    selectedKey: "agent:main:main",
    steps: ["agent:main:mode-target", "agent:main:main"],
  },
  { choice: "same", selectedKey: "agent:main:main", steps: ["agent:main:main"] },
])(
  "keeps the $choice choice visible and selected while remembered-session validation is pending",
  { timeout: 65_000 },
  async ({ selectedKey, steps }, { signal }) => {
    const stateDir = tempDirs.make("openclaw-tui-superseded-restore-");
    await seedRememberedSession(stateDir);
    const fixture = await sessionFixture(
      stateDir,
      {
        OPENCLAW_TUI_PTY_MAIN_SESSION_KEY: "agent:main:main",
        OPENCLAW_TUI_PTY_MODEL: "fixture-provider/fixture-model",
      },
      { holdSessionDescription: true },
    );
    await withFixture(fixture, async () => {
      await fixture.call("sessionDescriptionPending", signal, "sessionKey", REMEMBERED_SESSION_KEY);
      for (const sessionKey of steps) {
        await fixture.write(`/session ${sessionKey}\r`);
        await fixture.call("loadHistory", signal, "sessionKey", sessionKey);
      }
      const selectedRows = await fixture.rows((frame) =>
        frame.some((row) => row.trim() === `session ${selectedKey}`),
      );
      const label = `session ${selectedKey.split(":").at(-1)}`;
      expect(selectedRows.slice(0, 2).join(" ").replace(/\s+/gu, " ")).toContain(label);
      expect(selectedRows.find((row) => row.includes("| session "))).toContain(label);
      await fixture.releaseStartup();
      const rows = await fixture.containing("local ready");
      expect(rows.join("\n")).toContain(`session ${selectedKey.split(":").at(-1)}`);
      const marker = "superseded restore target proof";
      await sendTo(fixture, signal, marker, selectedKey);
    });
  },
);
it("starts normally when the pre-render state read throws", async () => {
  // Future schemas must fail inside the rendered UI, not reject before tui.start().
  const stateDir = tempDirs.make("openclaw-tui-future-state-");
  await seedRememberedSession(stateDir);
  // Make the seeded DB unreadable to the current schema owner before any query runs.
  const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA user_version = 999");
  db.close();
  const fixture = await sessionFixture(stateDir, { OPENCLAW_TUI_PTY_RESTORE_DELAY_MS: "10000" });
  await withFixture(fixture, async () => {
    // The failed read must leave the default label visible.
    const rows = await fixture.rows(
      (frame) =>
        frame.some((row) => row.includes("session main")) &&
        !frame.some((row) => row.includes("session picker-target")),
    );
    expect(rows.join("\n")).toContain("session main");
    expect(rows.join("\n")).not.toContain("session picker-target");
  });
}, 65_000);
it("persists the selected session before returning from Ctrl+D exit with empty input", async () => {
  const stateDir = tempDirs.make("openclaw-tui-exit-session-");
  const emptyFixture = await createFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_RETURN_STATE_KEY: `tui.lastSession.${SESSION_SCOPE_KEY}`,
    },
  });
  await withFixture(emptyFixture, async () => {
    await emptyFixture.output("local ready");
    await emptyFixture.write("/session agent:main:mode-target\r");
    await emptyFixture.rows(
      (frame) => frame.some((row) => row.trim() === "session agent:main:mode-target"),
      5_000,
    );
    await emptyFixture.write("\u0004");
    expect((await emptyFixture.run.waitForExit()).exitCode).toBe(0);
    const returned = (await readFixtureLog(emptyFixture.logPath)).find(
      (entry) => entry.method === "returned",
    );
    expect(returned?.payload).toEqual({ rememberedSessionKey: "agent:main:mode-target" });
  });
}, 65_000);
