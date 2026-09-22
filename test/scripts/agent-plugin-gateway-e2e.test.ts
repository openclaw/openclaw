import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { createDeferred } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";

const fixtures = createFixtureLifetime();
afterEach(() => fixtures.cleanup());
const cases = [
  ...(["fixture", "config"] as const).flatMap((phase) =>
    ([null, "SIGINT", "SIGTERM"] as const).map((signal) => ({
      phase,
      signal,
      boundary: `${phase} write`,
    })),
  ),
  { phase: "install", signal: "SIGTERM", boundary: "running installer" } as const,
];

it.skipIf(process.platform === "win32").for(cases)(
  "respects Agent Plugin E2E cancellation across the $boundary ($signal)",
  { timeout: 30_000 },
  async ({ phase, signal }, context) => {
    await fixtures.run(async () => {
      const controls = fixtures.createTempDir("agent-plugin-cancellation-");
      const home = path.join(controls, "home");
      const tmp = path.join(controls, "tmp");
      mkdirSync(home);
      mkdirSync(tmp);
      const release = path.join(controls, "release");
      const ready = createDeferred();
      const receivedSignal = createDeferred();
      let child: ChildProcess | undefined;
      const command = fixtures.track(
        runNodeScript(
          [
            "--import",
            "./scripts/tsx.mjs",
            "--import",
            new URL("./fixtures/agent-plugin-gateway-cancellation.mjs", import.meta.url).href,
            "scripts/agent-plugin-gateway-e2e.ts",
          ],
          {
            PATH: process.env.PATH,
            HOME: home,
            TMPDIR: tmp,
            TMP: tmp,
            TEMP: tmp,
            AGENT_PLUGIN_E2E_FIXTURE_DIR: controls,
            AGENT_PLUGIN_E2E_WRITE_PHASE: phase,
            ...(signal ? { AGENT_PLUGIN_E2E_SIGNAL: signal } : {}),
          },
          10_000,
          {
            cwd: process.cwd(),
            signal: context.signal,
            requireProcessTreeExit: true,
            maxBuffer: 128 * 1024,
            onReady(owned, output) {
              child = owned;
              owned.stdout!.on("data", () => {
                const text = output().stdout;
                if (text.includes("fixture-write-ready\n")) {
                  ready.resolve();
                }
                if (signal && text.includes(`fixture-signal-${signal}\n`)) {
                  receivedSignal.resolve();
                }
              });
            },
          },
        ),
      );
      const closedBeforeGate = command.then((result) => {
        throw new Error(`Entry point exited before the fixture gate: ${JSON.stringify(result)}`);
      });
      void closedBeforeGate.catch(() => {});
      try {
        await Promise.race([ready.promise, closedBeforeGate]);
        if (signal) {
          expect(child?.kill(signal)).toBe(true);
          await Promise.race([receivedSignal.promise, closedBeforeGate]);
        }
        writeFileSync(release, "release");
        const result = await command;
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status).toBeGreaterThan(0);
        const launchesFile = path.join(controls, "launches");
        const launches = existsSync(launchesFile)
          ? readFileSync(launchesFile, "utf8").trim().split("\n")
          : [];
        expect(launches).toEqual(
          signal ? (phase === "fixture" ? [] : ["install"]) : ["install", "mock"],
        );
        if (!signal) {
          expect(result.stderr).toContain("Synthetic service launch stopped at mock");
        }
        if (phase === "install") {
          expect(result.stderr).toContain("agent-plugin-gateway-e2e interrupted");
          expect(result.stderr).toContain("Managed command aborted");
        }
        const fixtureRoot = readFileSync(path.join(controls, "fixture-root"), "utf8");
        expect(existsSync(fixtureRoot)).toBe(false);
      } finally {
        writeFileSync(release, "release");
        await command;
      }
    });
  },
);
