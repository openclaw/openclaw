import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import {
  hasHistoricalSynchronizedFrameRow,
  readFixtureLog,
  type StartTuiPtyFixture,
  waitForSynchronizedFrameRows,
} from "./tui-pty-harness-assertion-test-support.js";

export function createTuiStartupRelease(
  tempDir: string,
  opts: { holdStartupHistory?: boolean; holdSessionDescription?: boolean },
) {
  const startupReleasePath =
    opts.holdStartupHistory || opts.holdSessionDescription
      ? path.join(tempDir, "startup.release")
      : undefined;
  let releaseStartupPromise: Promise<void> | undefined;
  const releaseStartup = () => {
    releaseStartupPromise ??= startupReleasePath
      ? writeFile(startupReleasePath, "")
      : Promise.resolve();
    return releaseStartupPromise;
  };
  return {
    env: {
      OPENCLAW_TUI_PTY_STARTUP_RELEASE_PATH: opts.holdStartupHistory
        ? startupReleasePath
        : undefined,
      OPENCLAW_TUI_PTY_SESSION_DESCRIPTION_RELEASE_PATH: opts.holdSessionDescription
        ? startupReleasePath
        : undefined,
    },
    releaseStartup,
    wrapDispose(run: { dispose: () => Promise<void> }) {
      if (startupReleasePath) {
        const dispose = run.dispose;
        // Suite cleanup must release held initialization even when its test never runs.
        run.dispose = async () => {
          try {
            await releaseStartup();
          } finally {
            await dispose();
          }
        };
      }
    },
  };
}

// Injects delayed session restore and history controls into the real-runTui PTY fixture.
export const TUI_PTY_STARTUP_SESSION_FIXTURE = {
  variables: `
      const restoreDelayMs = Number(process.env.OPENCLAW_TUI_PTY_RESTORE_DELAY_MS ?? 0);
      const restoreFailures = Number(process.env.OPENCLAW_TUI_PTY_RESTORE_FAILURES ?? 0);
      const reconnectHistoryDelayMs = Number(
        process.env.OPENCLAW_TUI_PTY_RECONNECT_HISTORY_DELAY_MS ?? 0,
      );
      let restoreAttempts = 0;
      let reconnectDuringRestore = process.env.OPENCLAW_TUI_PTY_RECONNECT_DURING_RESTORE === "1";
  `,
  sessionInventory: `
      const sessionDefaults = () => ({
        model: currentModel,
        modelProvider: "fixture-provider",
        contextTokens: 128,
        thinkingLevels,
      });
      const fixtureSessions = () => enablePickerFixture ? [
        sessionEntry("main"),
        ...Array.from({ length: Number(process.env.OPENCLAW_TUI_PTY_DECOY_COUNT ?? 0) }, (_, index) => ({
          ...sessionEntry(pickerSessionKey + "-decoy-" + index),
          label: pickerSessionKey + " label " + index,
        })),
        {
          ...sessionEntry(pickerSessionKey),
          derivedTitle: pickerSessionTitle,
          lastMessagePreview: pickerSessionPreview,
        },
      ] : [];
  `,
  loadHistory: `
          if (reconnectHistoryReady && reconnectHistoryDelayMs > 0) {
            reconnectHistoryReady = false;
            record("reconnectHistoryPending", { sessionKey });
            await new Promise((resolve) => setTimeout(resolve, reconnectHistoryDelayMs));
          }
  `,
  historyBarrier: `const startupReleasePath = process.env.OPENCLAW_TUI_PTY_STARTUP_RELEASE_PATH;
          if (startupReleasePath) {
            record("startupHistoryPending", { sessionKey });
            while (!existsSync(startupReleasePath)) {
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            record("startupHistoryReleased", { sessionKey });
          }`,
  describeSessionDelay: `
          if (reconnectDuringRestore) {
            reconnectDuringRestore = false;
            record("restoreReconnect");
            this.onDisconnected?.("fixture reconnect during restore");
            queueMicrotask(() => this.onConnected?.());
          }
          const descriptionReleasePath = process.env.OPENCLAW_TUI_PTY_SESSION_DESCRIPTION_RELEASE_PATH;
          if (descriptionReleasePath) {
            record("sessionDescriptionPending", { sessionKey: opts.sessionKey });
            while (!existsSync(descriptionReleasePath)) {
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            record("sessionDescriptionReleased", { sessionKey: opts.sessionKey });
          }
          if (restoreDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, restoreDelayMs));
          }
          if (restoreAttempts++ < restoreFailures) {
            throw new Error("fixture remembered-session lookup failed");
          }
  `,
} as const;

export async function exerciseStartupHistoryRendering(
  fixture: Awaited<ReturnType<StartTuiPtyFixture>> & {
    releaseStartup: () => Promise<void>;
  },
  timeoutMs: number,
) {
  try {
    await fixture.waitForLogEntry((entry) => entry.method === "startupHistoryPending", timeoutMs);
    let startupOutput = "";
    const startupRows = await waitForSynchronizedFrameRows(
      {
        ...fixture.run,
        output: () => (startupOutput = fixture.run.output()),
      },
      (rows) => rows.some((row) => row.includes("starting up")),
      timeoutMs,
    );
    expect(startupRows.join("\n")).not.toContain("local ready | idle");
    expect(
      hasHistoricalSynchronizedFrameRow(startupOutput, [], "local ready | idle", fixture.run),
    ).toBe(false);
    expect(await readFixtureLog(fixture.logPath)).not.toContainEqual(
      expect.objectContaining({ method: "startupHistoryReleased" }),
    );

    await fixture.releaseStartup();
    await waitForSynchronizedFrameRows(
      fixture.run,
      (rows) => rows.some((row) => row.includes("local ready | idle")),
      timeoutMs,
    );
  } finally {
    await fixture.releaseStartup();
  }
}
