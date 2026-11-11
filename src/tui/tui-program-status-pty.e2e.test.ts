import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { iterateAnsiSegments } from "../../packages/terminal-core/src/ansi-sequences.js";
import {
  objectFieldEquals,
  selectTuiFixtureSession,
  startTuiFixture,
  waitForSynchronizedFrameRows,
} from "./tui-pty-harness-fixture-test-support.js";

function waitForFrame(fixture: Awaited<ReturnType<typeof startTuiFixture>>, ...text: string[]) {
  return waitForSynchronizedFrameRows(
    fixture.run,
    (rows) => text.every((value) => rows.some((row) => row.includes(value))),
    20_000,
  );
}

function programStatusSequences(output: string): string[] {
  const sequences: string[] = [];
  for (const segment of iterateAnsiSegments(output)) {
    if (segment.kind === "ansi" && segment.value.startsWith("\x1b]7501;")) {
      const terminatorLength = segment.value.endsWith("\x1b\\") ? 2 : 1;
      sequences.push(segment.value.slice("\x1b]7501;".length, -terminatorLength));
    }
  }
  return sequences;
}

function expectStates(fixture: Awaited<ReturnType<typeof startTuiFixture>>, states: string[]) {
  expect(programStatusSequences(fixture.run.output())).toEqual(
    states.map((state) =>
      state === "?" ? state : `state=${state}${state === "clear" ? "" : ":app=openclaw"}`,
    ),
  );
}

it.for([
  { programStatus: "1", expected: ["idle", "working", "done", "clear"] },
  { programStatus: undefined, expected: ["?"] },
])(
  "reports the run lifecycle with OSC 7501 override $programStatus",
  { timeout: 30_000 },
  async ({ programStatus, expected }, { signal }) => {
    const message = "program status probe";
    const fixture = await startTuiFixture({ env: { PI_PROGRAM_STATUS: programStatus } });
    try {
      await fixture.run.waitForOutput("local ready", 20_000);
      await fixture.run.write(`${message}\r`, { delay: false });
      await fixture.waitForLogEntry(
        (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", message),
        signal,
      );
      await fixture.run.waitForOutput("PTY_RESPONSE:", 20_000);
      await waitForFrame(fixture, "PTY_RESPONSE:", "| idle");
      await fixture.run.write("/exit\r", { delay: false });
      expect((await fixture.run.waitForExit()).exitCode).toBe(0);
      expectStates(fixture, expected);
    } finally {
      await fixture.cleanup();
    }
  },
);

it("does not report completion when switching away from a streaming session", async ({
  signal,
}) => {
  const fixture = await startTuiFixture({ env: { PI_PROGRAM_STATUS: "1" } });
  const releaseStream = () =>
    writeFile(`${fixture.logPath}.streaming.release`, "release\n", "utf8");
  try {
    await fixture.run.waitForOutput("local ready", 20_000);
    await fixture.run.write("burst streaming proof\r", { delay: false });
    await waitForFrame(fixture, "T063", "streaming");
    await selectTuiFixtureSession(fixture, "agent:main:program-status-other", signal);
    await waitForFrame(fixture, "| idle");
    expectStates(fixture, ["idle", "working", "idle"]);

    // Complete the retired run, then prove the new session can report its own success.
    await releaseStream();
    await fixture.waitForLogEntry((entry) => entry.method === "streamingComplete", signal);
    await fixture.run.write("new session reply\r", { delay: false });
    await waitForFrame(fixture, "PTY_RESPONSE: new session reply", "| idle");
    await fixture.run.write("/exit\r", { delay: false });
    expect((await fixture.run.waitForExit()).exitCode).toBe(0);
    expectStates(fixture, ["idle", "working", "idle", "working", "done", "clear"]);
  } finally {
    await releaseStream();
    await fixture.cleanup();
  }
}, 30_000);
