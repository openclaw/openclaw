// Each guard proof runs in its own child process; never replace worker timers.
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import timers from "node:timers/promises";

export function installGuardClock(logPath, now = Date.parse("2026-01-02T00:00:00Z")) {
  mock.timers.enable({ apis: ["setTimeout"] });
  Date.now = () => now;
  timers.setTimeout = async (delay) => {
    appendFileSync(logPath, `${JSON.stringify({ method: "WAIT", delay })}\n`);
    now += delay;
  };
  syncBuiltinESMExports();
  return (elapsed) => {
    now += elapsed;
    mock.timers.tick(elapsed);
  };
}
