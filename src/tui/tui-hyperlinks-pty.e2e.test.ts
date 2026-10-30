import { expect, it } from "vitest";
import { iterateAnsiSegments } from "../../packages/terminal-core/src/ansi-sequences.js";
import {
  objectFieldEquals,
  startTuiFixture,
  waitForSynchronizedFrameRows,
} from "./tui-pty-harness-fixture-test-support.js";

function linkedText(output: string) {
  let target = "";
  const spans = new Map<string, string[]>();
  for (const segment of iterateAnsiSegments(output)) {
    if (segment.kind === "ansi" && segment.value.startsWith("\x1b]8;;")) {
      target = segment.value.slice(5, segment.value.endsWith("\x1b\\") ? -2 : -1);
    } else if (segment.kind !== "ansi" && target) {
      spans.set(target, [...(spans.get(target) ?? []), segment.value]);
    }
  }
  return spans;
}

it.for([
  ["VS Code", "vscode", 100, "label"],
  ["wrapped VS Code", "vscode", 36, "label/with/a/long/path"],
  ["unidentified terminal", "", 36, "label"],
] as const)(
  "preserves authored link targets in %s",
  { timeout: 30_000 },
  async ([, termProgram, cols, labelPath], { signal }) => {
    const target = "https://example.test/actual-destination";
    const plainTarget = "https://example.test/documentation";
    const visibleUrl = `https://example.test/${labelPath}`;
    const message = `[${visibleUrl}](${target}) and [Documentation](${plainTarget})`;
    const fixture = await startTuiFixture({
      env: {
        TERM_PROGRAM: termProgram,
        TMUX: undefined,
        KITTY_WINDOW_ID: undefined,
        GHOSTTY_RESOURCES_DIR: undefined,
        WEZTERM_PANE: undefined,
        ITERM_SESSION_ID: undefined,
        WT_SESSION: undefined,
        WARP_SESSION_ID: undefined,
        WARP_TERMINAL_SESSION_UUID: undefined,
        TERMINAL_EMULATOR: undefined,
        OPENCLAW_TUI_PTY_COLS: String(cols),
        OPENCLAW_TUI_PTY_ROWS: "30",
      },
    });
    try {
      await fixture.run.waitForOutput("local ready", 20_000);
      await fixture.run.write(`${message}\r`, { delay: false });
      await fixture.waitForLogEntry(
        (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", message),
        signal,
      );
      await fixture.run.waitForOutput("PTY_RESPONSE:", 20_000);
      const raw = fixture.run.output();
      const links = linkedText(raw.slice(raw.lastIndexOf("PTY_RESPONSE:")));
      if (termProgram) {
        expect(links.has(visibleUrl)).toBe(false);
        if (visibleUrl.length > cols) {
          expect(links.get(target)?.length).toBeGreaterThan(1);
        }
        expect(links.get(target)?.join("")).toContain(visibleUrl);
        expect(links.get(plainTarget)?.join("")).toContain("Documentation");
      } else {
        expect(links.has(target)).toBe(true);
        expect(links.has(plainTarget)).toBe(true);
      }
      await waitForSynchronizedFrameRows(
        fixture.run,
        (frame) =>
          frame.some((row) => row.includes("PTY_RESPONSE:")) &&
          frame.some((row) => row.includes("idle")),
        20_000,
      );
      await fixture.run.write("/exit\r", { delay: false });
      expect((await fixture.run.waitForExit()).exitCode).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  },
);
