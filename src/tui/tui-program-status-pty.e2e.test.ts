import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { iterateAnsiSegments } from "../../packages/terminal-core/src/ansi-sequences.js";
import {
  objectFieldEquals,
  selectTuiFixtureSession,
  startTuiFixture,
  waitForSynchronizedFrameRows,
} from "./tui-pty-harness-fixture-test-support.js";

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

it.for([
  {
    // The fixture PTY cannot answer the support query, so this forces reporting on.
    label: "a terminal with OSC 7501 support",
    programStatus: "1",
    expected: [
      "state=idle:app=openclaw",
      "state=working:app=openclaw",
      "state=done:app=openclaw",
      "state=clear",
    ],
  },
  {
    label: "a terminal that never answers the support query",
    programStatus: undefined,
    expected: ["?"],
  },
])(
  "reports the run lifecycle to $label",
  { timeout: 30_000 },
  async ({ label, programStatus, expected }, { signal }) => {
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
      await waitForSynchronizedFrameRows(
        fixture.run,
        (rows) =>
          rows.some((row) => row.includes("PTY_RESPONSE:")) &&
          rows.some((row) => row.includes("| idle")),
        20_000,
      );
      await fixture.run.write("/exit\r", { delay: false });
      expect((await fixture.run.waitForExit()).exitCode).toBe(0);
      const sequences = programStatusSequences(fixture.run.output());
      console.log(
        `[behavior-evidence] ${JSON.stringify({ label, sequences, terminal: "real PTY" })}`,
      );
      expect(sequences).toEqual(expected);
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
    await waitForSynchronizedFrameRows(
      fixture.run,
      (rows) =>
        rows.some((row) => row.includes("T063")) && rows.some((row) => row.includes("streaming")),
      20_000,
    );
    await selectTuiFixtureSession(fixture, "agent:main:program-status-other", signal);
    await waitForSynchronizedFrameRows(
      fixture.run,
      (rows) => rows.some((row) => row.includes("| idle")),
      20_000,
    );
    expect(programStatusSequences(fixture.run.output())).toEqual([
      "state=idle:app=openclaw",
      "state=working:app=openclaw",
      "state=idle:app=openclaw",
    ]);

    // Complete the retired run, then prove the new session can report its own success.
    await releaseStream();
    await fixture.waitForLogEntry((entry) => entry.method === "streamingComplete", signal);
    await fixture.run.write("new session reply\r", { delay: false });
    await waitForSynchronizedFrameRows(
      fixture.run,
      (rows) =>
        rows.some((row) => row.includes("PTY_RESPONSE: new session reply")) &&
        rows.some((row) => row.includes("| idle")),
      20_000,
    );
    await fixture.run.write("/exit\r", { delay: false });
    expect((await fixture.run.waitForExit()).exitCode).toBe(0);
    expect(programStatusSequences(fixture.run.output())).toEqual([
      "state=idle:app=openclaw",
      "state=working:app=openclaw",
      "state=idle:app=openclaw",
      "state=working:app=openclaw",
      "state=done:app=openclaw",
      "state=clear",
    ]);
  } finally {
    await releaseStream();
    await fixture.cleanup();
  }
}, 30_000);
