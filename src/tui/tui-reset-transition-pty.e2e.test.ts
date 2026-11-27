import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import {
  objectFieldEquals,
  readFixtureLog,
  startTuiFixture,
  tuiFixtureReceipts,
  waitForFixtureLogEntry,
  waitForSynchronizedFrameRows,
  writeTuiPtyFixtureScript,
} from "./tui-pty-harness-fixture-test-support.js";
import { startRuntimePty } from "./tui-pty-test-support.js";

const OUTPUT_TIMEOUT_MS = 2_000;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function sentEntries(logPath: string) {
  return (await readFixtureLog(logPath)).filter((entry) => entry.method === "sendChat");
}

it("keeps pasted /exit in chat and /stop shared", async ({ signal }) => {
  const stateDir = tempDirs.make("openclaw-tui-input-pty-");
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_OFFLINE: "1",
    },
  });
  try {
    await fixture.run.waitForOutput("local ready", 20_000);
    for (const [input, reply] of [
      ["\u001b[200~/exit\n\u001b[201~\r", "/exit"],
      ["  ordinary input  \r", "ordinary input"],
    ] as const) {
      await fixture.run.write(input, { delay: false });
      await waitForSynchronizedFrameRows(
        fixture.run,
        (frame) => frame.some((row) => row.includes(`PTY_RESPONSE: ${reply}`)),
        OUTPUT_TIMEOUT_MS,
      );
    }
    await fixture.run.write("\u001b[200~/stop\n\u001b[201~\r", { delay: false });
    await fixture.waitForLogEntry((entry) => entry.method === "abortChat", signal);
    expect(await sentEntries(fixture.logPath)).toMatchObject([
      { payload: { message: "/exit" } },
      { payload: { message: "ordinary input" } },
    ]);
    await fixture.run.write("/exit\r", { delay: false });
    expect((await fixture.run.waitForExit()).exitCode).toBe(0);
  } finally {
    await fixture.cleanup();
  }
}, 25_000);

for (const nativePaste of [false, true]) {
  const input = nativePaste ? "large paste with default macOS coalescing" : "typed suffix";
  it.skipIf(nativePaste && process.platform !== "darwin")(
    `TUI reset transition PTY (${input}) preserves overlapping input while /reset owns the terminal session transition`,
    async ({ signal }) => {
      const tempDir = tempDirs.make("openclaw-tui-reset-pty-");
      const argv = resolveRuntimeWorkerArgv(pathToFileURL(await writeTuiPtyFixtureScript(tempDir)));
      const logPath = path.join(tempDir, "fixture-log.jsonl");
      const resetReleasePath = path.join(tempDir, "release-reset-session");
      const newerDraft = nativePaste
        ? Array.from({ length: 11 }, (_, index) => `line-${index}`).join("\n")
        : "newer suffix";
      const preservedDraft = `overlap during reset\n${newerDraft}`;
      const run = await startRuntimePty(process.execPath, argv, {
        cwd: process.cwd(),
        env: {
          OPENCLAW_THEME: "dark",
          OPENCLAW_TUI_PTY_LOG_PATH: logPath,
          OPENCLAW_TUI_PTY_RESET_RELEASE_PATH: resetReleasePath,
          OPENCLAW_TUI_PTY_SUBMIT_BURST_WINDOW_MS: nativePaste ? undefined : "1000",
          OPENCLAW_TUI_PTY_TYPE_CHUNK_SIZE: "1",
          OPENCLAW_TUI_PTY_TYPE_DELAY_MS: "2",
          // Exercise macOS coalescing without Apple Terminal's modifier-state lookup.
          TERM_PROGRAM: nativePaste ? "iTerm.app" : undefined,
          NO_COLOR: undefined,
        },
        exitTimeoutMs: 8_000,
        outputTimeoutMs: OUTPUT_TIMEOUT_MS,
      });

      try {
        const waitForLogEntry = (method: string, field?: [string, string]) =>
          waitForFixtureLogEntry(
            logPath,
            (entry) => entry.method === method && (!field || objectFieldEquals(entry, ...field)),
            { receipts: tuiFixtureReceipts, run, signal },
          );

        await run.waitForOutput("local ready", 20_000);
        await run.write("/reset\r", { delay: false });
        await waitForLogEntry("resetSession", ["reason", "reset"]);
        if (nativePaste) {
          await run.write(`overlap during reset\r\u001b[200~${newerDraft}\u001b[201~`, {
            delay: false,
          });
          await run.waitForOutput("session change in progress; wait for /reset to finish");
          expect(await sentEntries(logPath)).toEqual([]);
        } else {
          await run.write("overlap during reset\r");
          await waitForLogEntry("submitBurstCaptured", ["value", "overlap during reset"]);
          await run.write(newerDraft);
          // Admission must use the Enter-time transition snapshot, before the paste flush.
        }
        await writeFile(resetReleasePath, "released\n", "utf8");
        await run.waitForOutput("session main (Reset session after)");
        if (!nativePaste) {
          await run.waitForOutput(preservedDraft, 7_000);
        }

        await run.write("\r", { delay: false });
        await waitForLogEntry("sendChat", nativePaste ? undefined : ["message", preservedDraft]);
        await run.waitForOutput("PTY_RESPONSE: overlap during reset", 7_000);

        const sent = await sentEntries(logPath);
        expect(sent).toMatchObject([{ payload: { message: preservedDraft } }]);
        if (nativePaste) {
          await run.waitForOutput("line-10");
        }
      } finally {
        await run.forceKill();
        await run.dispose();
      }
    },
    25_000,
  );
}
