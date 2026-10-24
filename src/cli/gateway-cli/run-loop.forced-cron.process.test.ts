import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { gatewayDirectStopEntrypoints } from "../cli-entrypoint.test-support.js";
import { createProcessFixture } from "./run-loop.process.test-support.js";

const fixtures = createProcessFixture();

it.skipIf(process.platform === "win32").for([
  { signal: "SIGUSR2", mode: "force" },
  { signal: "SIGTERM", mode: "force" },
  { signal: "SIGUSR2", mode: "timeout" },
] as const)(
  "settles admitted cron work before $signal $mode restart",
  { timeout: 60_000 },
  async ({ signal, mode }, { signal: testSignal }) => {
    const root = fixtures.make("openclaw-forced-cron-");
    const { child, observed } = fixtures.start(
      gatewayDirectStopEntrypoints.forcedCronFixture,
      root,
      mode,
      testSignal,
      { OPENCLAW_NO_RESPAWN: "1", TSX_DISABLE_CACHE: "1" },
      true,
    );
    const { closed, waitForOutput } = observed;
    await waitForOutput("process proof: ready:1");
    expect(child.kill(signal)).toBe(true);
    if (mode === "timeout") {
      await waitForOutput("process proof: cron-cancelled:restart");
      await waitForOutput("process proof: close-entered");
    } else {
      await waitForOutput("draining active work before");
      expect(observed.output).not.toContain("process proof: close-entered");
    }
    child.send("inspect");
    await waitForOutput("process proof: held:starts=1:connectionPending=false:cronPending=1");
    expect(fs.existsSync(path.join(root, "cleanup.txt"))).toBe(false);
    expect(observed.output).not.toContain("process proof: close-completed");
    expect(observed.output).not.toContain("process proof: ready:2");
    expect(child.exitCode).toBeNull();
    child.send("release");
    if (signal === "SIGUSR2") {
      await waitForOutput("process proof: ready:2");
      expect(child.kill("SIGINT")).toBe(true);
    }
    const outcome = await withinTest(closed, testSignal).catch((cause: unknown) => {
      throw new Error(observed.output, { cause });
    });
    expect(outcome).toEqual([0, null]);
    expect(fs.readFileSync(path.join(root, "cleanup.txt"), "utf8")).toBe("settled\n");
    expect(observed.output.indexOf("process proof: cron-cleanup-settled")).toBeLessThan(
      observed.output.indexOf("process proof: close-completed"),
    );
    expect(observed.output).not.toContain("shutdown deadline reached");
  },
);
