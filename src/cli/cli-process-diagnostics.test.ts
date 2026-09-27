import { describe, expect, it } from "vitest";
import { formatCliProcessFailure, runCliProcessChild } from "./cli-process-child.test-helpers.js";

const diagnosticPrefix = "[cli-process-diagnostics] ";

function exitBoundaries(stderr: string): unknown[] {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith(`${diagnosticPrefix}{`))
    .map((line) => JSON.parse(line.slice(diagnosticPrefix.length)));
}

describe.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
  "CLI process exit diagnostics",
  () => {
    it.each(["natural", "explicit"])("preserves %s process exit", async (mode) => {
      const result = await runCliProcessChild({
        nodeArgs: [
          "--trace-exit",
          "-e",
          `
process.on('exit', function fixtureExit(code) {
  console.log(JSON.stringify({ pid: process.pid, code, receiver: this === process }));
});
${mode === "explicit" ? "process.exit(3);" : "process.exitCode = 3;"}
`,
        ],
        env: { ...process.env, NODE_OPTIONS: undefined },
      });
      const failure = formatCliProcessFailure({ reason: `${mode} exit diagnostics`, ...result });
      expect(result.signal, failure).toBeNull();
      expect(result.code, failure).toBe(3);
      const output = JSON.parse(result.stdout);
      expect(output, failure).toMatchObject({ code: 3, receiver: true });
      expect(exitBoundaries(result.stderr), failure).toMatchObject([
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
          failure,
        ).toBeGreaterThan(result.stderr.indexOf('"phase":"exit-listeners-return"'));
      }
    });

    it("forwards borrowed receivers, arguments, return values, and thrown errors without exit diagnostics", async () => {
      const result = await runCliProcessChild({
        nodeArgs: [
          "--trace-exit",
          "-e",
          `
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const receiver = new EventEmitter();
const event = Symbol('fixture-event');
const payload = {};
const failure = new Error('fixture-listener-failed');
receiver.on(event, function (value, second) {
  assert.equal(this, receiver);
  assert.equal(value, payload);
  assert.equal(second, 7);
});
receiver.on('exit', function (code) {
  assert.equal(this, receiver);
  assert.equal(code, 41);
});
assert.equal(Reflect.apply(process.emit, receiver, [event, payload, 7]), true);
assert.equal(Reflect.apply(process.emit, receiver, ['missing']), false);
assert.equal(Reflect.apply(process.emit, receiver, ['exit', 41]), true);
receiver.on('exit', () => { throw failure; });
assert.throws(() => Reflect.apply(process.emit, receiver, ['exit', 41]), (error) => error === failure);
process.on(event, function (value) {
  assert.equal(this, process);
  assert.equal(value, payload);
});
assert.equal(process.emit(event, payload), true);
assert.equal(process.emit('fixture-missing'), false);
console.log('forwarded');
`,
        ],
        env: { ...process.env, NODE_OPTIONS: undefined },
      });
      const failure = formatCliProcessFailure({ reason: "borrowed emit diagnostics", ...result });
      expect(result.signal, failure).toBeNull();
      expect(result.code, failure).toBe(0);
      expect(result.stdout, failure).toBe("forwarded\n");
      // Only the child's real exit is instrumented, never a borrowed or non-exit dispatch.
      expect(exitBoundaries(result.stderr), failure).toMatchObject([
        { phase: "exit-listeners-enter", exitCode: 0 },
        { phase: "exit-listeners-return", exitCode: 0 },
      ]);
    });

    it("records throwing process exit listeners without replacing their error", async () => {
      const result = await runCliProcessChild({
        nodeArgs: [
          "--trace-exit",
          "-e",
          `
const assert = require('node:assert/strict');
const failure = new Error('fixture-exit-failed');
process.once('exit', function fixtureThrow() {
  assert.equal(this, process);
  throw failure;
});
assert.throws(() => process.emit('exit', 9), (error) => error === failure);
console.log('preserved error');
`,
        ],
        env: { ...process.env, NODE_OPTIONS: undefined },
      });
      const failure = formatCliProcessFailure({ reason: "throwing exit diagnostics", ...result });
      expect(result.signal, failure).toBeNull();
      expect(result.code, failure).toBe(0);
      expect(result.stdout, failure).toBe("preserved error\n");
      expect(exitBoundaries(result.stderr), failure).toMatchObject([
        { phase: "exit-listeners-enter", exitCode: 9 },
        { phase: "exit-listeners-throw", exitCode: 9 },
        { phase: "exit-listeners-enter", exitCode: 0 },
        { phase: "exit-listeners-return", exitCode: 0 },
      ]);
    });
  },
);
