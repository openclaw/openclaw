import { expect, it } from "vitest";
import {
  startTuiFixture,
  waitForSynchronizedFrameRows,
} from "./tui-pty-harness-fixture-test-support.js";

it("shows named theme problems as chat log notices", async () => {
  const fixture = await startTuiFixture({
    env: { OPENCLAW_THEME: "missing-theme", OPENCLAW_TUI_PTY_COLS: "200" },
  });
  try {
    await fixture.run.waitForOutput("local ready", 20_000);
    const rows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) => frame.some((row) => row.includes('theme "missing-theme"')),
      5_000,
    );
    expect(rows.find((row) => row.includes('theme "missing-theme"'))).toContain(
      "missing-theme.json not found; using the built-in palette",
    );
  } finally {
    await fixture.cleanup();
  }
}, 25_000);
