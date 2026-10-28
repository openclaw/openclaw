import { expect, it } from "vitest";
import {
  objectFieldEquals,
  startTuiFixture,
  waitForSynchronizedFrameRows,
} from "./tui-pty-harness-fixture-test-support.js";

// Terminal bells that are not OSC/APC terminators.
function countBells(output: string) {
  // oxlint-disable-next-line eslint/no-control-regex -- Escape sequences are the thing being matched.
  const OSC_OR_APC = new RegExp("\\u001b[\\]_][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)", "gu");
  return output.replace(OSC_OR_APC, "").split("\x07").length - 1;
}

it(
  "rings once and keeps chat output plain when a screen reader run finishes",
  {
    timeout: 40_000,
  },
  async ({ signal }) => {
    const message = "screen reader probe";
    const fixture = await startTuiFixture({ screenReader: true });
    try {
      await fixture.run.waitForOutput("local ready", 20_000);
      expect(fixture.run.output()).toContain("Screen reader mode on");
      expect(countBells(fixture.run.output())).toBe(0);
      await fixture.run.write(`${message}\r`, { delay: false });
      await fixture.waitForLogEntry(
        (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", message),
        signal,
      );
      await fixture.run.waitForOutput("PTY_RESPONSE:", 20_000);
      const rows = await waitForSynchronizedFrameRows(
        fixture.run,
        (frame) => frame.some((row) => row.includes("Done in")),
        20_000,
      );
      const text = rows.join("\n");
      expect(text).toContain("You: " + message);
      expect(text).toContain("Assistant: ");
      expect(rows.some((row) => row.startsWith("$"))).toBe(true);
      expect(countBells(fixture.run.output())).toBe(1);
      await fixture.run.write("/exit\r", { delay: false });
      expect((await fixture.run.waitForExit()).exitCode).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  },
);

it(
  "draws picker rows over whole chat rows so earlier messages are not read with the options",
  {
    timeout: 90_000,
  },
  async () => {
    const fixture = await startTuiFixture({
      screenReader: true,
      env: {
        OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
        OPENCLAW_TUI_PTY_COLS: "100",
        OPENCLAW_TUI_PTY_ROWS: "30",
      },
    });
    try {
      await fixture.run.waitForOutput("local ready", 20_000);
      // Fill the screen so the centered picker lands on rows that hold chat text.
      for (let i = 1; i <= 4; i += 1) {
        await fixture.run.write(`kitties number ${i}.\r`, { delay: false });
        await waitForSynchronizedFrameRows(
          fixture.run,
          (frame) => frame.filter((row) => row.includes("Done in")).length === i,
          20_000,
        );
      }
      await fixture.run.write("/models\r", { delay: false });
      const rows = await waitForSynchronizedFrameRows(
        fixture.run,
        (frame) => frame.some((row) => row.includes("Fixture 2")),
        20_000,
      );
      const optionRows = rows.filter((row) => row.includes("fixture-provider/"));
      expect(optionRows.length).toBeGreaterThan(1);
      expect(optionRows.filter((row) => /You:|Assistant:|System:|kitties/.test(row))).toEqual([]);
      await fixture.run.write("\x1b", { delay: false });
      await fixture.run.write("/exit\r", { delay: false });
    } finally {
      await fixture.cleanup();
    }
  },
);
