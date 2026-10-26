import { describe, expect, it } from "vitest";
import { shouldEnableNodeDiagnosticReports } from "../../scripts/lib/node-diagnostic-report.mts";
import { formatCliProcessFailure, runCliProcessChild } from "./cli-process-child.test-helpers.js";

const diagnosticPrefix = "[cli-process-diagnostics] ";

async function runDiagnostic(source: string, expected: { code: number; stdout?: string }) {
  const result = await runCliProcessChild({
    nodeArgs: ["--trace-exit", "-e", source],
    env: { ...process.env, NODE_OPTIONS: undefined },
  });
  const failure = formatCliProcessFailure({ reason: "exit diagnostics", ...result });
  expect(result, failure).toMatchObject({ signal: null, ...expected });
  return { ...result, failure };
}

function exitBoundaries(stderr: string): unknown[] {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith(`${diagnosticPrefix}{`))
    .map((line) => JSON.parse(line.slice(diagnosticPrefix.length)));
}

describe.skipIf(!shouldEnableNodeDiagnosticReports())("CLI process exit diagnostics", () => {
  it.each(["natural", "explicit"])("preserves %s process exit", async (mode) => {
    const result = await runDiagnostic(
      `
process.on('exit', function fixtureExit(code) {
  console.log(JSON.stringify({ pid: process.pid, code, receiver: this === process }));
});
${mode === "explicit" ? "process.exit(3);" : "process.exitCode = 3;"}
`,
      { code: 3 },
    );
    const output = JSON.parse(result.stdout);
    expect(output, result.failure).toMatchObject({ code: 3, receiver: true });
    expect(exitBoundaries(result.stderr), result.failure).toMatchObject([
      {
        pid: output.pid,
        phase: "exit-listeners-enter",
        exitCode: 3,
        listenerNames: ["fixtureExit"],
      },
      { pid: output.pid, phase: "exit-listeners-return", exitCode: 3 },
    ]);
    if (mode === "explicit") {
      expect(
        result.stderr.indexOf("WARNING: Exited the environment with code 3"),
        result.failure,
      ).toBeGreaterThan(result.stderr.indexOf('"phase":"exit-listeners-return"'));
    }
  });

  it("preserves event dispatch and instruments only process exit, including thrown errors", async () => {
    const result = await runDiagnostic(
      `
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const receiver = new EventEmitter();
const event = Symbol('fixture-event');
const payload = {};
const failure = new Error('fixture-listener-failed');
receiver.on(event, function (value, second) {
  assert.deepEqual([this === receiver, value === payload, second], [true, true, 7]);
});
receiver.on('exit', function (code) {
  assert.deepEqual([this === receiver, code], [true, 41]);
});
assert.equal(Reflect.apply(process.emit, receiver, [event, payload, 7]), true);
assert.equal(Reflect.apply(process.emit, receiver, ['missing']), false);
assert.equal(Reflect.apply(process.emit, receiver, ['exit', 41]), true);
receiver.on('exit', () => { throw failure; });
assert.throws(() => Reflect.apply(process.emit, receiver, ['exit', 41]), (error) => error === failure);
process.on(event, function (value) {
  assert.deepEqual([this === process, value === payload], [true, true]);
});
assert.equal(process.emit(event, payload), true);
assert.equal(process.emit('fixture-missing'), false);
process.once('exit', function fixtureThrow() {
  assert.equal(this, process);
  throw failure;
});
assert.throws(() => process.emit('exit', 9), (error) => error === failure);
console.log('forwarded');
`,
      { code: 0, stdout: "forwarded\n" },
    );
    // Borrowed and non-exit dispatches must not add diagnostic records.
    expect(exitBoundaries(result.stderr), result.failure).toMatchObject([
      { phase: "exit-listeners-enter", exitCode: 9 },
      { phase: "exit-listeners-throw", exitCode: 9 },
      { phase: "exit-listeners-enter", exitCode: 0 },
      { phase: "exit-listeners-return", exitCode: 0 },
    ]);
  });
});
