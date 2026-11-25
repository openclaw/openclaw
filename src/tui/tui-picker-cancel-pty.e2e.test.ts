import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, type TestContext } from "vitest";
import {
  objectFieldEquals,
  readFixtureLog,
  startTuiFixture,
  waitForSynchronizedFrameRows,
} from "./tui-pty-harness-fixture-test-support.js";

const cancelKeys = [
  { key: "\x1b", name: "Escape" },
  { key: "\u0003", name: "Ctrl+C" },
  { key: "\x1b[99;5u", name: "Kitty Ctrl+C" },
  { key: "\x1b[27;5;99~", name: "modifyOtherKeys Ctrl+C" },
];

async function pickerFixture(context: TestContext, env: NodeJS.ProcessEnv = {}) {
  const fixture = await startTuiFixture({
    env: {
      TERM_PROGRAM: "vscode",
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_COLS: "100",
      OPENCLAW_TUI_PTY_ROWS: "30",
      ...env,
    },
  });
  context.onTestFinished(fixture.cleanup);
  await fixture.run.waitForOutput("local ready", 20_000);
  const frame = (predicate: Parameters<typeof waitForSynchronizedFrameRows>[1]) =>
    waitForSynchronizedFrameRows(fixture.run, predicate, 20_000);
  return {
    ...fixture,
    frame,
    row: (predicate: (row: string) => boolean) => frame((rows) => rows.some(predicate)),
    write: (input: string) => fixture.run.write(input, { delay: false }),
  };
}

it("restores the editor before the model update finishes", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "openclaw-picker-selection-"));
  const releasePath = path.join(directory, "release-patch");
  context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const fixture = await pickerFixture(context, {
    OPENCLAW_TUI_PTY_PATCH_RELEASE_PATH: releasePath,
  });
  await fixture.write("/models\r");
  await fixture.row((row) => row.includes("Fixture 2"));
  await fixture.write("\x1b[B\r");
  await fixture.waitForLogEntry((entry) => entry.method === "patchSession", context.signal);

  const message = "draft after model selection";
  await fixture.write("\r" + message);
  const rows = await fixture.row((row) => row.includes(message));
  const patches = (await readFixtureLog(fixture.logPath)).filter(
    (entry) => entry.method === "patchSession",
  );
  expect(patches).toHaveLength(1);
  expect(rows.some((row) => row.trimStart().startsWith("search:"))).toBe(false);

  await writeFile(releasePath, "release");
  await fixture.run.waitForOutput("model set to fixture-provider/fixture-model-2", 20_000);
  await fixture.write("\r");
  await fixture.waitForLogEntry(
    (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", message),
    context.signal,
  );
  await fixture.row((row) => row.includes("PTY_RESPONSE: " + message));
}, 30_000);

it.for(
  ["/models", "/sessions"].flatMap((command) =>
    cancelKeys.map(({ key, name }) => ({ command, key, name })),
  ),
)(
  "returns to chat from $command with $name",
  { timeout: 30_000 },
  async ({ command, key, name }, context) => {
    const fixture = await pickerFixture(context, {
      TMUX: undefined,
      KITTY_WINDOW_ID: undefined,
      GHOSTTY_RESOURCES_DIR: undefined,
      WEZTERM_PANE: undefined,
      ITERM_SESSION_ID: undefined,
      WT_SESSION: undefined,
      WARP_SESSION_ID: undefined,
      WARP_TERMINAL_SESSION_UUID: undefined,
      TERMINAL_EMULATOR: undefined,
    });
    if (name === "Kitty Ctrl+C") {
      await fixture.write("\x1b[?1u");
    }
    await fixture.write(command + "\r");
    const prompt = command === "/sessions" ? "Filter:" : "search:";
    await fixture.row((row) => row.trimStart().startsWith(prompt));
    await fixture.write("missing");
    await fixture.row((row) => row.includes(prompt) && row.includes("missing"));
    await fixture.write(key);
    if (key === "\x1b") {
      // Let the terminal disambiguate lone Escape before sending printable input.
      await fixture.frame((rows) =>
        command === "/sessions"
          ? rows.some((row) => row.trim() === "Filter: >")
          : !rows.some((row) => row.trimStart().startsWith(prompt)),
      );
    }

    if (command === "/sessions") {
      await fixture.write("Picker");
      const cleared = await fixture.row((row) => row.includes(prompt) && row.includes("Picker"));
      expect(cleared.some((row) => row.trim() === "Filter: > Picker")).toBe(true);
      expect(cleared.some((row) => row.includes("No match"))).toBe(false);
      await fixture.write(key);
      await fixture.row((row) => row.trim() === "Filter: >");
      await fixture.write(key);
      if (key === "\x1b") {
        await fixture.frame((rows) => !rows.some((row) => row.trimStart().startsWith(prompt)));
      }
    }

    const message = "picker cancel proof";
    await fixture.write(message + "\r");
    const rows = await fixture.row(
      (row) =>
        row.includes("PTY_RESPONSE: " + message) || (row.includes(prompt) && row.includes(message)),
    );
    expect(rows.some((row) => row.includes("PTY_RESPONSE: " + message))).toBe(true);
    expect(rows.some((row) => row.trimStart().startsWith(prompt))).toBe(false);
    expect(
      (await readFixtureLog(fixture.logPath)).some(
        (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", message),
      ),
    ).toBe(true);
    await fixture.write("/exit\r");
    expect((await fixture.run.waitForExit()).exitCode).toBe(0);
  },
);
