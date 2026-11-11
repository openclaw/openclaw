import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { scriptProcessEntrypoints } from "../../scripts/script-process-runtime.test-support.js";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { awaitGateBeforeSettlement, createDeferred } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";

const scriptUrl = resolveRuntimeWorkerUrl(scriptProcessEntrypoints.agentPluginGatewayE2e);
const fixtures = createFixtureLifetime();
afterEach(() => fixtures.cleanup());
type RunOptions = NonNullable<Parameters<typeof runNodeScript>[3]>;
function setup(phase: string, signal: AbortSignal, extraEnv: NodeJS.ProcessEnv = {}) {
  const controls = fixtures.createTempDir("agent-plugin-e2e-");
  const file = (name: string) => path.join(controls, name);
  const read = (name: string) => readFileSync(file(name), "utf8");
  const env = {
    PATH: process.env.PATH,
    ...Object.fromEntries(["HOME", "TMPDIR", "TMP", "TEMP"].map((name) => [name, controls])),
    AGENT_PLUGIN_E2E_FIXTURE_DIR: controls,
    AGENT_PLUGIN_E2E_WRITE_PHASE: phase,
    ...extraEnv,
  };
  return {
    read,
    lines: (name: string) => (existsSync(file(name)) ? read(name).trim().split("\n") : []),
    release: () => writeFileSync(file("release"), "release"),
    expectCleanup: () => expect(existsSync(read("fixture-root"))).toBe(false),
    run: (onReady?: RunOptions["onReady"]) =>
      fixtures.track(
        runNodeScript(workerArgs, env, 10_000, {
          cwd: process.cwd(),
          signal,
          requireProcessTreeExit: true,
          maxBuffer: 128 * 1024,
          onReady,
        }),
      ),
  };
}
const preload = new URL("./fixtures/agent-plugin-gateway-cancellation.mjs", import.meta.url).href;
const workerArgs: Parameters<typeof runNodeScript>[0] = (workerArgv) =>
  workerArgv(scriptUrl).toSpliced(-1, 0, "--import", preload);
const signals = [null, "SIGINT", "SIGTERM"] as const;
const cases = [
  ...["fixture", "config"].flatMap((phase) => signals.map((signal) => ({ phase, signal }))),
  { phase: "install", signal: "SIGTERM" } as const,
];

it.skipIf(process.platform === "win32").for([undefined, "node"])(
  "selects the %s runtime for the serving Agent Plugin Gateway",
  (runtime, { signal }) =>
    fixtures.run(async () => {
      const fixture = setup("runtime", signal, {
        CI: "",
        OPENCLAW_VITEST_RUNTIME: runtime,
        OPENCLAW_BUN_PATH: process.execPath,
      });
      const result = await fixture.run();
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status).toBeGreaterThan(0);
      expect(result.stderr).toContain("Synthetic service launch stopped at gateway");
      const { command, hostExecPath } = JSON.parse(fixture.read("gateway-command"));
      expect(command).toBe(runtime === "node" ? hostExecPath : process.execPath);
      fixture.expectCleanup();
    }),
);

it.skipIf(process.platform === "win32").for(cases)(
  "respects Agent Plugin E2E cancellation during $phase ($signal)",
  { timeout: 30_000 },
  ({ phase, signal }, context) =>
    fixtures.run(async () => {
      const fixture = setup(
        phase,
        context.signal,
        signal ? { AGENT_PLUGIN_E2E_SIGNAL: signal } : {},
      );
      const ready = createDeferred();
      const receivedSignal = createDeferred();
      let sendSignal: (value: NodeJS.Signals) => boolean = () => false;
      const command = fixture.run((owned, output) => {
        sendSignal = owned.kill.bind(owned);
        owned.stdout!.on("data", () => {
          const text = output().stdout;
          if (text.includes("fixture-write-ready\n")) {
            ready.resolve();
          }
          if (signal && text.includes(`fixture-signal-${signal}\n`)) {
            receivedSignal.resolve();
          }
        });
      });
      const waitFor = (gate: Promise<void>) =>
        awaitGateBeforeSettlement(gate, command, "Entry point exited before the fixture gate");
      try {
        await waitFor(ready.promise);
        if (signal) {
          expect(sendSignal(signal)).toBe(true);
          await waitFor(receivedSignal.promise);
        }
        fixture.release();
        const result = await command;
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status).toBeGreaterThan(0);
        expect(fixture.lines("launches")).toEqual(
          signal ? (phase === "fixture" ? [] : ["install"]) : ["install", "mock"],
        );
        if (!signal) {
          expect(result.stderr).toContain("Synthetic service launch stopped at mock");
        }
        if (phase === "install") {
          expect(result.stderr).toContain("agent-plugin-gateway-e2e interrupted");
          expect(result.stderr).toContain("Managed command aborted");
        }
        fixture.expectCleanup();
      } finally {
        fixture.release();
        await command;
      }
    }),
);
