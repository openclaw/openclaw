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
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function seedRememberedSession(
  stateDir: string,
  sessionKey: string = REMEMBERED_SESSION_KEY,
) {
  await writeTuiLastSessionKey({
    scopeKey: buildTuiLastSessionScopeKey({
      connectionUrl: "pty-fixture://local",
      agentId: "main",
      sessionScope: "per-sender",
    }),
    sessionKey,
    stateDir,
  });
}

async function waitForLogCount(params: {
  fixture: Awaited<ReturnType<typeof startTuiFixture>>;
  predicate: (entry: FixtureLogEntry) => boolean;
  count: number;
  signal: AbortSignal;
}) {
  const matches = new Set<number>();
  await params.fixture.waitForLogEntry((entry, index) => {
    if (params.predicate(entry)) {
      matches.add(index);
    }
    return matches.size >= params.count;
  }, params.signal);
  return await readFixtureLog(params.fixture.logPath);
}

function markerSends(entries: FixtureLogEntry[], marker: string) {
  return entries.filter(
    (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
  );
}

async function waitForSubmitDecision(params: {
  fixture: Awaited<ReturnType<typeof startTuiFixture>>;
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
      Promise.race([
        fixture.waitForLogEntry(
          (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
          signal,
        ),
        rejected.promise,
      ]),
      signal,
    );
    return { entries: await readFixtureLog(fixture.logPath), output: readOutput() };
  } finally {
    unsubscribe();
    cancelled.abort();
  }
}

afterEach(async () => {
  await disposeActiveTuiFixtures();
});

it("previews and restores the exact remembered session behind six newer prefix and label matches", async ({
  signal,
}) => {
  const stateDir = tempDirs.make("openclaw-tui-exact-description-");
  await seedRememberedSession(stateDir);
  const fixture = await startTuiFixture({
    holdSessionDescription: true,
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_DECOY_COUNT: "6",
    },
  });
  try {
    await fixture.waitForLogEntry(
      (entry) =>
        entry.method === "sessionDescriptionPending" &&
        objectFieldEquals(entry, "sessionKey", REMEMBERED_SESSION_KEY),
      signal,
    );
    const earlyRows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) =>
        frame.some((row) => row.includes("session picker-target")) &&
        !frame.some((row) => row.includes("session main")),
      8_000,
    );
    expect(earlyRows.join("\n")).toContain("session picker-target");
    expect(await readFixtureLog(fixture.logPath)).not.toContainEqual(
      expect.objectContaining({ method: "sessionDescriptionReleased" }),
    );
    await fixture.releaseStartup();
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
    const rows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) => frame.some((row) => row.includes("local ready")),
      STARTUP_TIMEOUT_MS,
    );
    expect(rows.join("\n")).toContain("session picker-target");
    expect(rows.join("\n")).not.toContain("session main");
    await fixture.run.write("exact restore proof\r", { delay: false });
    const sent = await fixture.waitForLogEntry(
      (entry) =>
        entry.method === "sendChat" && objectFieldEquals(entry, "message", "exact restore proof"),
      signal,
    );
    expect(sent.payload).toMatchObject({ sessionKey: REMEMBERED_SESSION_KEY });
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("keeps raw unknown sessions excluded from remembered restore", async () => {
  const stateDir = tempDirs.make("openclaw-tui-unknown-description-");
  await seedRememberedSession(stateDir, "unknown");
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_PICKER_SESSION_KEY: "unknown",
    },
  });
  try {
    const rows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) => frame.some((row) => row.includes("local ready")),
      STARTUP_TIMEOUT_MS,
    );
    expect(rows.join("\n")).toContain("session main");
    expect(rows.join("\n")).not.toContain("session unknown");
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("refreshes the footer only for an accepted fallback destination without reloading history", async () => {
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_TUI_PTY_MODEL: "fixture-model",
      OPENCLAW_TUI_PTY_COLS: "100",
      OPENCLAW_TUI_PTY_ROWS: "30",
    },
  });
  try {
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
    await fixture.run.write("fallback footer proof\r", { delay: false });
    const before = await waitForSynchronizedFrameRows(
      fixture.run,
      (rows) => rows.some((row) => row.includes("FALLBACK_RUN_ACTIVE")),
      STARTUP_TIMEOUT_MS,
    );
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
      await fixture.run.write("/gateway-status\r", { delay: false });
      const rows = await waitForSynchronizedFrameRows(
        fixture.run,
        (frame) => frame.some((row) => row.includes(`FALLBACK_EVENT_DELIVERED_${step}`)),
        STARTUP_TIMEOUT_MS,
      );
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
      await fixture.run.write("/exit\r", { delay: false });
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
  const fixture = await startTuiFixture({
    env: {
      // File completion is outside this contract; keep fd discovery from replacing its menu.
      OPENCLAW_AGENT_DIR: agentDir,
      OPENCLAW_OFFLINE: "1",
      PATH: "",
      OPENCLAW_TUI_PTY_THINKING_LABEL: "on",
      OPENCLAW_TUI_PTY_SAFE_THINKING_LABEL: "always on",
    },
  });

  try {
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
    await fixture.waitForLogEntry((entry) => entry.method === "listCommands", signal);

    for (const [index, { label, id }] of [
      { label: "on", id: "fixture-thinking" },
      { label: "always on", id: "fixture-thinking-safe" },
    ].entries()) {
      await fixture.run.write(`/think ${label}`, { delay: false });
      await fixture.run.waitForOutput(`→ ${label}`, STARTUP_TIMEOUT_MS);
      await fixture.run.write("\r", { delay: false });
      const entries = await waitForLogCount({
        fixture,
        signal,
        predicate: (entry) => entry.method === "patchSession",
        count: index + 1,
      });
      expect(entries.findLast((entry) => entry.method === "patchSession")?.payload).toMatchObject({
        thinkingLevel: id,
      });
      await fixture.run.waitForOutput(`thinking set to ${label}`, STARTUP_TIMEOUT_MS);
    }
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("clears session-scoped names and modes while trace changes and delivery stays process-owned", async ({
  signal,
}) => {
  const modeStartupTimeoutMs = 20_000;
  const modeFixture = await startTuiFixture({
    env: {
      OPENCLAW_TUI_PTY_DELIVER: "1",
      OPENCLAW_TUI_PTY_MODEL: "fixture-model",
    },
  });
  try {
    await modeFixture.run.waitForOutput("local ready", modeStartupTimeoutMs);
    await modeFixture.run.waitForOutput("deliver:on", modeStartupTimeoutMs);
    await modeFixture.run.write("/session agent:main:mode-source\r", { delay: false });
    await modeFixture.waitForLogEntry(
      (entry) =>
        entry.method === "loadHistory" &&
        objectFieldEquals(entry, "sessionKey", "agent:main:mode-source"),
      signal,
    );
    await modeFixture.run.waitForOutput(
      "trace:raw | reasoning:stream | deliver:on",
      modeStartupTimeoutMs,
    );
    await modeFixture.run.waitForOutput("Production incident", STARTUP_TIMEOUT_MS);

    await modeFixture.run.write("/session agent:main:mode-target\r", { delay: false });
    await modeFixture.waitForLogEntry(
      (entry) =>
        entry.method === "loadHistory" &&
        objectFieldEquals(entry, "sessionKey", "agent:main:mode-target"),
      signal,
    );
    const targetRows = await waitForSynchronizedFrameRows(
      modeFixture.run,
      (rows) =>
        rows.some((row) => row.trim() === "session agent:main:mode-target") &&
        rows.some((row) => row.includes("| session mode-target | fixture-model |")),
      modeStartupTimeoutMs,
    );
    const targetOutput = targetRows.join("\n");
    expect(targetOutput).toContain("deliver:on");
    expect(targetOutput).not.toContain(" | fast | ");
    expect(targetOutput).not.toContain("fast:auto");
    expect(targetOutput).not.toContain("verbose full");
    expect(targetOutput).not.toContain("trace:raw");
    expect(targetOutput).not.toContain("reasoning:stream");
    expect(targetOutput).not.toContain("Production incident");

    await modeFixture.run.write("/trace on\r", { delay: false });
    await modeFixture.waitForLogEntry(
      (entry) => entry.method === "patchSession" && objectFieldEquals(entry, "traceLevel", "on"),
      signal,
    );
    await modeFixture.run.waitForOutput("trace | deliver:on", modeStartupTimeoutMs);

    await modeFixture.run.write("delivery proof\r", { delay: false });
    const sent = await modeFixture.waitForLogEntry(
      (entry) =>
        entry.method === "sendChat" && objectFieldEquals(entry, "message", "delivery proof"),
      signal,
    );
    expect(sent.payload).toMatchObject({ deliver: true });
  } finally {
    await modeFixture.cleanup();
  }
}, 25_000);

it("keeps the active stream when the current session is selected again", async () => {
  const fixture = await startTuiFixture();
  try {
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
    await fixture.run.write("streaming prompt\r", { delay: false });
    await fixture.run.waitForOutput("PTY_STREAMING: streaming prompt", STARTUP_TIMEOUT_MS);
    const historyLoadsBefore = (await readFixtureLog(fixture.logPath)).filter(
      (entry) => entry.method === "loadHistory",
    ).length;

    await fixture.run.write("/session main\r/think\r", { delay: false });
    await fixture.run.waitForOutput("usage: /think", STARTUP_TIMEOUT_MS);
    const rows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) => frame.some((row) => row.includes("PTY_STREAMING: streaming prompt")),
      STARTUP_TIMEOUT_MS,
    );

    expect(rows.join("\n")).not.toContain("local ready | idle");
    expect(
      (await readFixtureLog(fixture.logPath)).filter((entry) => entry.method === "loadHistory"),
    ).toHaveLength(historyLoadsBefore);
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("hides a stale approval when startup restores the remembered session", async ({ signal }) => {
  const stateDir = tempDirs.make("openclaw-tui-identity-");
  await seedRememberedSession(stateDir);
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_INITIAL_APPROVAL_SESSION_KEY: "agent:main:main",
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
    },
  });

  try {
    await fixture.waitForLogEntry(
      (entry) =>
        entry.method === "loadHistory" &&
        objectFieldEquals(entry, "sessionKey", REMEMBERED_SESSION_KEY),
      signal,
    );
    await fixture.waitForLogEntry(
      (entry) =>
        entry.method === "listPluginApprovals" && objectFieldEquals(entry, "pending", true),
      signal,
    );
    const rows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) =>
        frame.some((row) => row.includes("session picker-target")) &&
        frame.some((row) => row.includes("local ready")),
      STARTUP_TIMEOUT_MS,
    );

    expect(rows.join("\n")).not.toContain("plugin approval");
  } finally {
    await fixture.cleanup();
  }
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
    const fixture = await startTuiFixture({
      holdStartupHistory: phase === "global alias",
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
        ...env,
      },
    });
    try {
      if (phase === "reconnect history") {
        await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
        await fixture.run.write("/gateway-status\r", { delay: false });
        await fixture.waitForLogEntry(
          (entry) => entry.method === "reconnectHistoryPending",
          signal,
        );
      } else if (phase === "stale restore generation") {
        await fixture.waitForLogEntry((entry) => entry.method === "restoreReconnect", signal);
        await waitForLogCount({
          fixture,
          signal,
          predicate: (entry) =>
            entry.method === "describeSession" &&
            objectFieldEquals(entry, "sessionKey", sessionKey),
          count: 2,
        });
      } else {
        await fixture.waitForLogEntry(
          (entry) =>
            entry.method === (phase === "global alias" ? "startupHistoryPending" : "loadHistory") &&
            objectFieldEquals(entry, "sessionKey", sessionKey),
          signal,
        );
      }
      const outputOffset = fixture.run.visibleOutput().length;
      await fixture.run.write(`${marker}\r`, { delay: false });
      const decision = await waitForSubmitDecision({ fixture, marker, outputOffset, signal });
      expect(markerSends(decision.entries, marker).map((entry) => entry.payload)).toEqual([]);
      expect(decision.output).toContain("local runtime not ready — message not sent");
      await fixture.releaseStartup();
      const readyMarkers =
        phase === "reconnect history"
          ? ["gateway reconnected after transport loss", marker]
          : [`session ${sessionKey.split(":").at(-1)}`, "local ready", marker];
      const rows = await waitForSynchronizedFrameRows(
        fixture.run,
        (frame) => readyMarkers.every((text) => frame.some((row) => row.includes(text))),
        STARTUP_TIMEOUT_MS,
      );
      expect(rows.join("\n")).toContain(marker);
      expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(0);

      await fixture.run.write("\r", { delay: false });
      const sent = await fixture.waitForLogEntry(
        (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
        signal,
      );
      expect(sent.payload).toMatchObject({ sessionKey });
      expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  },
);

it.for([{ failInitialHistory: false }, { failInitialHistory: true }])(
  "handles literal initial messages when startup history failure is $failInitialHistory",
  { timeout: 65_000 },
  async ({ failInitialHistory }, { signal }) => {
    const initialMessage = "!literal initial message";
    const fixture = await startTuiFixture({
      failInitialHistory,
      env: {
        OPENCLAW_STATE_DIR: tempDirs.make("openclaw-tui-initial-message-"),
        OPENCLAW_TUI_PTY_SESSION: REMEMBERED_SESSION_KEY,
        OPENCLAW_TUI_PTY_INITIAL_MESSAGE: initialMessage,
      },
    });
    try {
      if (!failInitialHistory) {
        const sent = await fixture.waitForLogEntry(
          (entry) =>
            entry.method === "sendChat" && objectFieldEquals(entry, "message", initialMessage),
          signal,
        );
        expect(sent.payload).toMatchObject({
          sessionKey: REMEMBERED_SESSION_KEY,
          message: initialMessage,
        });
        await fixture.run.waitForOutput(`PTY_RESPONSE: ${initialMessage}`, STARTUP_TIMEOUT_MS);
        expect(markerSends(await readFixtureLog(fixture.logPath), initialMessage)).toHaveLength(1);
        return;
      }
      await fixture.waitForLogEntry((entry) => entry.method === "initialHistoryFailed", signal);
      await fixture.run.waitForOutput(
        "initial message not sent — retry it after the session is ready",
        STARTUP_TIMEOUT_MS,
      );
      expect(markerSends(await readFixtureLog(fixture.logPath), initialMessage)).toEqual([]);
      await fixture.run.write(`/session ${REMEMBERED_SESSION_KEY}\r`, { delay: false });
      await waitForLogCount({
        fixture,
        signal,
        predicate: (entry) =>
          entry.method === "loadHistory" &&
          objectFieldEquals(entry, "sessionKey", REMEMBERED_SESSION_KEY),
        count: 2,
      });
      await waitForSynchronizedFrameRows(
        fixture.run,
        (rows) => rows.some((row) => row.trim() === `session ${REMEMBERED_SESSION_KEY}`),
        STARTUP_TIMEOUT_MS,
      );
      expect(markerSends(await readFixtureLog(fixture.logPath), initialMessage)).toEqual([]);
      const explicitMessage = "explicit message after history recovery";
      await fixture.run.write(`${explicitMessage}\r`, { delay: false });
      const sent = await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "sendChat" && objectFieldEquals(entry, "message", explicitMessage),
        signal,
      );
      expect(sent.payload).toMatchObject({
        sessionKey: REMEMBERED_SESSION_KEY,
        message: explicitMessage,
      });
      await fixture.run.waitForOutput(`PTY_RESPONSE: ${explicitMessage}`, STARTUP_TIMEOUT_MS);
      const entries = await readFixtureLog(fixture.logPath);
      expect(markerSends(entries, initialMessage)).toEqual([]);
      expect(markerSends(entries, explicitMessage)).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  },
);

it("keeps an explicit launch session authoritative over remembered state", async ({ signal }) => {
  const stateDir = tempDirs.make("openclaw-tui-explicit-session-");
  const explicitSession = "agent:main:explicit-target";
  const marker = "explicit startup session proof";
  await seedRememberedSession(stateDir);
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_SESSION: explicitSession,
    },
  });

  try {
    await fixture.run.waitForOutput("session explicit-target", STARTUP_TIMEOUT_MS);
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
    await fixture.run.write(`${marker}\r`, { delay: false });
    const sent = await fixture.waitForLogEntry(
      (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
      signal,
    );
    expect(sent.payload).toMatchObject({ sessionKey: explicitSession });
    const entries = await readFixtureLog(fixture.logPath);
    expect(
      entries.some((entry) => objectFieldEquals(entry, "sessionKey", REMEMBERED_SESSION_KEY)),
    ).toBe(false);
    expect(markerSends(entries, marker)).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("clears the provisional label after a remembered lookup error and retries on reconnect", async ({
  signal,
}) => {
  const stateDir = tempDirs.make("openclaw-tui-restore-failure-");
  const marker = "restore failure fallback proof";
  await seedRememberedSession(stateDir);
  const fixture = await startTuiFixture({
    holdSessionDescription: true,
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_RESTORE_FAILURES: "1",
      OPENCLAW_TUI_PTY_DISCONNECT_REASON: "fixture restore lookup retry",
    },
  });

  try {
    await fixture.waitForLogEntry(
      (entry) =>
        entry.method === "sessionDescriptionPending" &&
        objectFieldEquals(entry, "sessionKey", REMEMBERED_SESSION_KEY),
      signal,
    );
    const earlyRows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) =>
        frame.some((row) => row.includes("session picker-target")) &&
        !frame.some((row) => row.includes("session main")),
      8_000,
    );
    expect(earlyRows.join("\n")).toContain("session picker-target");
    expect(await readFixtureLog(fixture.logPath)).not.toContainEqual(
      expect.objectContaining({ method: "sessionDescriptionReleased" }),
    );
    await fixture.releaseStartup();
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);

    // After fallback the header/footer must agree with the send target, not
    // retain the stale provisional label.
    const rows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) => frame.some((row) => row.includes("local ready")),
      STARTUP_TIMEOUT_MS,
    );
    expect(rows.join("\n")).toContain("session main");
    expect(rows.join("\n")).not.toContain("session picker-target");

    await fixture.run.write(`${marker}\r`, { delay: false });
    const sent = await fixture.waitForLogEntry(
      (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
      signal,
    );
    expect(sent.payload).toMatchObject({ sessionKey: "main" });
    expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(1);
    await fixture.run.waitForOutput(`PTY_RESPONSE: ${marker}`, STARTUP_TIMEOUT_MS);

    // Another TUI can replace the scoped pointer after fallback. A transient
    // validation error must leave the next connection eligible to restore it.
    await seedRememberedSession(stateDir);
    await fixture.run.write("/gateway-status\r", { delay: false });
    await fixture.waitForLogEntry((entry) => entry.method === "disconnect", signal);
    await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) =>
        frame.some((row) => row.includes("local ready")) &&
        frame.some((row) => row.includes("session picker-target")),
      STARTUP_TIMEOUT_MS,
    );
    const retryMarker = "restore lookup retry proof";
    await fixture.run.write(`${retryMarker}\r`, { delay: false });
    const retried = await fixture.waitForLogEntry(
      (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", retryMarker),
      signal,
    );
    expect(retried.payload).toMatchObject({ sessionKey: REMEMBERED_SESSION_KEY });
    expect(markerSends(await readFixtureLog(fixture.logPath), retryMarker)).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
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
    const fixture = await startTuiFixture({
      holdSessionDescription: true,
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
        OPENCLAW_TUI_PTY_MAIN_SESSION_KEY: "agent:main:main",
        OPENCLAW_TUI_PTY_MODEL: "fixture-provider/fixture-model",
      },
    });
    try {
      await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "sessionDescriptionPending" &&
          objectFieldEquals(entry, "sessionKey", REMEMBERED_SESSION_KEY),
        signal,
      );
      for (const sessionKey of steps) {
        await fixture.run.write(`/session ${sessionKey}\r`, { delay: false });
        await fixture.waitForLogEntry(
          (entry) =>
            entry.method === "loadHistory" && objectFieldEquals(entry, "sessionKey", sessionKey),
          signal,
        );
      }
      const selectedRows = await waitForSynchronizedFrameRows(
        fixture.run,
        (frame) => frame.some((row) => row.trim() === `session ${selectedKey}`),
        STARTUP_TIMEOUT_MS,
      );
      const label = `session ${selectedKey.split(":").at(-1)}`;
      expect(selectedRows.slice(0, 2).join(" ").replace(/\s+/gu, " ")).toContain(label);
      expect(selectedRows.find((row) => row.includes("| session "))).toContain(label);
      await fixture.releaseStartup();
      const rows = await waitForSynchronizedFrameRows(
        fixture.run,
        (frame) => frame.some((row) => row.includes("local ready")),
        STARTUP_TIMEOUT_MS,
      );
      expect(rows.join("\n")).toContain(`session ${selectedKey.split(":").at(-1)}`);
      const marker = "superseded restore target proof";
      await fixture.run.write(`${marker}\r`, { delay: false });
      const sent = await fixture.waitForLogEntry(
        (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
        signal,
      );
      expect(sent.payload).toMatchObject({ sessionKey: selectedKey });
    } finally {
      await fixture.cleanup();
    }
  },
);

it("starts normally when the pre-render state read throws", async () => {
  // A state database using a newer schema version makes readTuiLastSessionKey
  // throw during the pre-render lookup. The TUI must still start (reach its
  // established startup-failure path inside the started UI) rather than
  // rejecting runTui() before tui.start().
  const stateDir = tempDirs.make("openclaw-tui-future-state-");
  await seedRememberedSession(stateDir);
  // Overwrite the seeded DB with a valid but future-version database so the
  // read-only open throws a schema-version error before any query runs.
  const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE IF NOT EXISTS config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL)",
  );
  const scopeKey = buildTuiLastSessionScopeKey({
    connectionUrl: "pty-fixture://local",
    agentId: "main",
    sessionScope: "per-sender",
  });
  db.prepare(
    "INSERT OR REPLACE INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
  ).run(`tui.lastSession.${scopeKey}`, JSON.stringify(REMEMBERED_SESSION_KEY), Date.now());
  db.exec("PRAGMA user_version = 999");
  db.close();

  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_RESTORE_DELAY_MS: "10000",
    },
  });

  try {
    // The TUI must reach a rendered frame — it must not reject runTui() before
    // tui.start(). The schema-version error also breaks the post-connect
    // restore, so the status shows "startup failed"; what matters is that the
    // UI is active and the header uses the default session, not the remembered
    // label that the failed read could not produce.
    const rows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) =>
        frame.some((row) => row.includes("session main")) &&
        !frame.some((row) => row.includes("session picker-target")),
      STARTUP_TIMEOUT_MS,
    );
    expect(rows.join("\n")).toContain("session main");
    expect(rows.join("\n")).not.toContain("session picker-target");
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("persists the selected session before returning from Ctrl+D exit with empty input", async () => {
  const stateDir = tempDirs.make("openclaw-tui-exit-session-");
  const scopeKey = buildTuiLastSessionScopeKey({
    connectionUrl: "pty-fixture://local",
    agentId: "main",
    sessionScope: "per-sender",
  });
  const emptyFixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_RETURN_STATE_KEY: `tui.lastSession.${scopeKey}`,
    },
  });
  try {
    await emptyFixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
    await emptyFixture.run.write("/session agent:main:mode-target\r", { delay: false });
    await waitForSynchronizedFrameRows(
      emptyFixture.run,
      (frame) => frame.some((row) => row.trim() === "session agent:main:mode-target"),
      5_000,
    );
    await emptyFixture.run.write("\u0004", { delay: false });
    expect((await emptyFixture.run.waitForExit()).exitCode).toBe(0);
    const returned = (await readFixtureLog(emptyFixture.logPath)).find(
      (entry) => entry.method === "returned",
    );
    expect(returned?.payload).toEqual({ rememberedSessionKey: "agent:main:mode-target" });
  } finally {
    await emptyFixture.cleanup();
  }
}, 65_000);
