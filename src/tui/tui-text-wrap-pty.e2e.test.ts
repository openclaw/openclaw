import { expect, it } from "vitest";
import {
  objectFieldEquals,
  startTuiFixture,
  waitForSynchronizedFrameRows,
} from "./tui-pty-harness-fixture-test-support.js";

it("preserves a long email address in the user's message and assistant reply", async () => {
  const address = "alexandertheodorewilliamson@example.org";
  const fixture = await startTuiFixture({
    env: {
      TERM_PROGRAM: "vscode",
      OPENCLAW_TUI_PTY_COLS: "120",
      OPENCLAW_TUI_PTY_ROWS: "30",
    },
  });
  try {
    await fixture.run.waitForOutput("local ready", 20_000);
    await fixture.run.write(`${address}\r`, { delay: false });
    await fixture.waitForLogEntry(
      (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", address),
    );
    const rows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) => frame.some((row) => row.includes("PTY_RESPONSE:")),
      20_000,
    );
    console.log("[text-wrap-frame] " + JSON.stringify({ rows }));
    expect(rows.filter((row) => row.includes(address))).toHaveLength(2);
  } finally {
    await fixture.run.forceKill();
    await fixture.cleanup();
  }
}, 30_000);
