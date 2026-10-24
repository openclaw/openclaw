import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
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
async function waitForSubmitDecision(params: {
  fixture: Fixture;
  marker: string;
  outputOffset: number;
  signal: AbortSignal;
}) {
  const { fixture, marker, outputOffset } = params;
  const cancelled = new AbortController();
  const signal = AbortSignal.any([params.signal, cancelled.signal]);
  const rejected = createDeferred();
  const readOutput = () => fixture.run.visibleOutput().slice(outputOffset);
  const observeOutput = () => {
    if (readOutput().includes("local runtime not ready — message not sent")) {
      rejected.resolve();
    }
  };
  const unsubscribe = fixture.run.onOutput(observeOutput);
  try {
    observeOutput();
    await withinTest(
      Promise.race([fixture.call("sendChat", signal, "message", marker), rejected.promise]),
      signal,
    );
    return { entries: await readFixtureLog(fixture.logPath), output: readOutput() };
  } finally {
    unsubscribe();
    cancelled.abort();
  }
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
it("keeps raw unknown sessions excluded from remembered restore", async () => {
  const stateDir = tempDirs.make("openclaw-tui-unknown-description-");
  await seedRememberedSession(stateDir, "unknown");
  const fixture = await sessionFixture(stateDir, {
    OPENCLAW_TUI_PTY_PICKER_SESSION_KEY: "unknown",
  });
  await withFixture(fixture, async () => {
    const rows = await fixture.containing("local ready");
    expect(rows.join("\n")).toContain("session main");
    expect(rows.join("\n")).not.toContain("session unknown");
  });
}, 65_000);
it("refreshes the footer only for an accepted fallback destination without reloading history", async () => {
  const fixture = await createFixture({
    env: {
      OPENCLAW_TUI_PTY_MODEL: "fixture-model",
      OPENCLAW_TUI_PTY_COLS: "100",
      OPENCLAW_TUI_PTY_ROWS: "30",
    },
  });
  try {
    await fixture.output("local ready");
    await fixture.write("fallback footer proof\r");
    const before = await fixture.containing("FALLBACK_RUN_ACTIVE");
    const footerRows = (rows: string[]) =>
      rows.filter((row) => row.includes("| session main (Main) |"));
    expect(footerRows(before)).toHaveLength(1);
    const initialFooter = footerRows(before)[0]!;
    expect(initialFooter).toContain("fixture-model");
    const backendCalls = (entries: FixtureLogEntry[]) =>
      entries.filter((entry) =>
        ["loadHistory", "describeSession", "listSessions", "patchSession", "sendChat"].includes(
          entry.method,
        ),
      );
    const initialCalls = backendCalls(await readFixtureLog(fixture.logPath));
    expect(initialCalls.filter((entry) => entry.method === "sendChat")).toHaveLength(1);
    expect(initialCalls.filter((entry) => entry.method === "patchSession")).toHaveLength(0);
    for (const step of [1, 2, 3]) {
      await fixture.write("/gateway-status\r");
      const rows = await fixture.containing(`FALLBACK_EVENT_DELIVERED_${step}`);
      const entries = await readFixtureLog(fixture.logPath);
      const calls = backendCalls(entries);
      expect(calls).toEqual(initialCalls);
      expect(entries.findLast((entry) => entry.method === "fallbackSelection")?.payload).toEqual({
        step,
        model: "fixture-model",
      });
      expect(footerRows(rows)).toHaveLength(1);
      if (step < 3) {
        expect(footerRows(rows)[0]).toBe(initialFooter);
      } else {
        expect
          .soft(footerRows(rows)[0], "TUI_FALLBACK_FOOTER_DESTINATION")
          .toBe(initialFooter.replace("fixture-model", "fixture-fallback-model"));
      }
    }
  } finally {
    try {
      await fixture.write("/exit\r");
      const exit = await fixture.run.waitForExit();
      expect(exit.exitCode, fixture.run.output()).toBe(0);
      expect(exit.signal ?? 0).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  }
}, 65_000);
it("submits provider-specific thinking labels with one Enter", async ({ signal }) => {
  const agentDir = tempDirs.make("openclaw-tui-thinking-agent-");
  const fixture = await createFixture({
    env: {
      // File completion is outside this contract; keep fd discovery from replacing its menu.
      OPENCLAW_AGENT_DIR: agentDir,
      OPENCLAW_OFFLINE: "1",
      PATH: "",
      OPENCLAW_TUI_PTY_THINKING_LABEL: "on",
      OPENCLAW_TUI_PTY_SAFE_THINKING_LABEL: "always on",
    },
  });
  await withFixture(fixture, async () => {
    await fixture.output("local ready");
    await fixture.call("listCommands", signal);
    for (const [index, { label, id }] of [
      { label: "on", id: "fixture-thinking" },
      { label: "always on", id: "fixture-thinking-safe" },
    ].entries()) {
      await fixture.write(`/think ${label}`);
      await fixture.output(`→ ${label}`);
      await fixture.write("\r");
      const entries = await waitForLogCount(
        fixture,
        signal,
        (entry) => entry.method === "patchSession",
        index + 1,
      );
      expect(entries.findLast((entry) => entry.method === "patchSession")?.payload).toMatchObject({
        thinkingLevel: id,
      });
      await fixture.output(`thinking set to ${label}`);
    }
  });
}, 65_000);
it("clears session-scoped names and modes while trace changes and delivery stays process-owned", async ({
  signal,
}) => {
  const modeStartupTimeoutMs = 20_000;
  const modeFixture = await createFixture({
    env: {
      OPENCLAW_TUI_PTY_DELIVER: "1",
      OPENCLAW_TUI_PTY_MODEL: "fixture-model",
    },
  });
  await withFixture(modeFixture, async () => {
    await modeFixture.output("local ready", modeStartupTimeoutMs);
    await modeFixture.output("deliver:on", modeStartupTimeoutMs);
    await modeFixture.write("/session agent:main:mode-source\r");
    await modeFixture.call("loadHistory", signal, "sessionKey", "agent:main:mode-source");
    await modeFixture.output("trace:raw | reasoning:stream | deliver:on", modeStartupTimeoutMs);
    await modeFixture.output("Production incident");
    await modeFixture.write("/session agent:main:mode-target\r");
    await modeFixture.call("loadHistory", signal, "sessionKey", "agent:main:mode-target");
    const targetRows = await modeFixture.rows(
      (rows) =>
        rows.some((row) => row.trim() === "session agent:main:mode-target") &&
        rows.some((row) => row.includes("| session mode-target | fixture-model |")),
      modeStartupTimeoutMs,
    );
    const targetOutput = targetRows.join("\n");
    expect(targetOutput).toContain("deliver:on");
    expect(targetOutput).not.toMatch(
      / \| fast \| |fast:auto|verbose full|trace:raw|reasoning:stream|Production incident/u,
    );
    await modeFixture.write("/trace on\r");
    await modeFixture.call("patchSession", signal, "traceLevel", "on");
    await modeFixture.output("trace | deliver:on", modeStartupTimeoutMs);
    await modeFixture.write("delivery proof\r");
    const sent = await modeFixture.call("sendChat", signal, "message", "delivery proof");
    expect(sent.payload).toMatchObject({ deliver: true });
  });
}, 25_000);
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
      const outputOffset = fixture.run.visibleOutput().length;
      await fixture.write(`${marker}\r`);
      const decision = await waitForSubmitDecision({ fixture, marker, outputOffset, signal });
      expect(markerSends(decision.entries, marker).map((entry) => entry.payload)).toEqual([]);
      expect(decision.output).toContain("local runtime not ready — message not sent");
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
it.for([{ failInitialHistory: false }, { failInitialHistory: true }])(
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
      if (!failInitialHistory) {
        const sent = await fixture.call("sendChat", signal, "message", initialMessage);
        expect(sent.payload).toMatchObject({
          sessionKey: REMEMBERED_SESSION_KEY,
          message: initialMessage,
        });
        await fixture.output(`PTY_RESPONSE: ${initialMessage}`);
        expect(markerSends(await readFixtureLog(fixture.logPath), initialMessage)).toHaveLength(1);
        return;
      }
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
  const fixture = await sessionFixture(stateDir, { OPENCLAW_TUI_PTY_SESSION: explicitSession });
  await withFixture(fixture, async () => {
    await fixture.output("session explicit-target");
    await fixture.output("local ready");
    await sendTo(fixture, signal, marker, explicitSession);
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
  db.exec(
    "CREATE TABLE IF NOT EXISTS config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL)",
  );
  db.prepare(
    "INSERT OR REPLACE INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
  ).run(`tui.lastSession.${SESSION_SCOPE_KEY}`, JSON.stringify(REMEMBERED_SESSION_KEY), Date.now());
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
