import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shellQuote } from "../../scripts/e2e/parallels/host-command.ts";
import {
  ensureSmokeGuestRuntime,
  installSmokeRuntimeCompanions,
  SmokeRunController,
  type SmokeCliOptions,
} from "../../scripts/e2e/parallels/smoke-common.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Parallels smoke controller", () => {
  it.each([
    ["fresh", false, false, false, ["fresh", "summary", "stop"], "pass", "skip"],
    ["upgrade", false, true, true, ["upgrade", "summary"], "skip", "pass"],
    ["both", true, true, false, ["fresh", "upgrade", "summary", "stop"], "fail", "pass"],
  ] as const)(
    "runs %s lanes and finalizes artifacts",
    async (mode, failFresh, json, keepServer, expectedEvents, freshMain, upgrade) => {
      const expectedStatus = { freshMain, upgrade };
      const root = tempDirs.make("parallels-smoke-controller-");
      const artifacts = path.join(root, "tgz");
      mkdirSync(artifacts);
      const events: string[] = [];
      const stop = vi.fn(async () => {
        events.push("stop");
        throw new Error("server already stopped");
      });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const previousExitCode = process.exitCode;
      process.exitCode = undefined;
      class FixtureSmoke extends SmokeRunController<SmokeCliOptions> {
        protected status = { freshMain: "skip", upgrade: "skip" };

        constructor() {
          super({
            mode,
            json,
            keepServer,
            hostPort: 0,
            hostPortExplicit: false,
            installUrl: "https://example.invalid/install.sh",
            provider: "openai",
            snapshotHint: "fixture",
            vmName: "fixture",
          });
          this.tgzDir = artifacts;
          this.server = { hostIp: "127.0.0.1", port: 0, stop, urlFor: () => "" };
        }

        async run(): Promise<void> {
          try {
            await this.runLanesAndFinish();
          } finally {
            await this.cleanupArtifacts();
          }
        }

        protected async runFreshLane(): Promise<void> {
          events.push("fresh");
          if (failFresh) {
            throw new Error("fresh assertion failed");
          }
        }

        protected async runUpgradeLane(): Promise<void> {
          events.push("upgrade");
        }

        protected async writeSummary(): Promise<string> {
          events.push("summary");
          const summaryPath = path.join(root, "summary.json");
          writeFileSync(summaryPath, `${JSON.stringify(this.status)}\n`);
          return summaryPath;
        }

        protected printSummary(summaryPath: string): void {
          process.stdout.write(`summary: ${summaryPath}\n`);
        }
      }
      try {
        await new FixtureSmoke().run();
        expect(events).toEqual(expectedEvents);
        expect(stdout.mock.calls.map(([text]) => text).join("")).toBe(
          json
            ? `${JSON.stringify(expectedStatus)}\n`
            : `summary: ${path.join(root, "summary.json")}\n`,
        );
        expect(stderr.mock.calls.map(([text]) => text).join("")).toBe(
          failFresh ? "warn: fresh lane failed: fresh assertion failed\n" : "",
        );
        expect(process.exitCode).toBe(failFresh ? 1 : undefined);
        expect(existsSync(artifacts)).toBe(keepServer);
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
        process.exitCode = previousExitCode;
      }
    },
  );
});

describe("Parallels runtime companion setup", () => {
  it("does not install unrelated companions", async () => {
    const readCli = vi.fn();
    const installCli = vi.fn();
    await installSmokeRuntimeCompanions({ provider: "anthropic", readCli, installCli });
    expect(readCli).not.toHaveBeenCalled();
    expect(installCli).not.toHaveBeenCalled();
  });

  it("leaves the shipped pre-consent CLI to provision its own companion version", async () => {
    const readCli = vi.fn((args: string[]) => {
      expect(args).toEqual(["plugins", "install", "--help"]);
      return "Usage: openclaw plugins install [options] <spec>\n  --pin  Pin resolved version\n";
    });
    const installCli = vi.fn();
    await installSmokeRuntimeCompanions({ provider: "openai", readCli, installCli });
    expect(readCli).toHaveBeenCalledTimes(1);
    expect(installCli).not.toHaveBeenCalled();
  });

  it("pins only the reviewed runtime companion to the installed candidate", async () => {
    const version = "2026.8.1-beta.2";
    const readCli = vi.fn((args: string[]) =>
      args[0] === "--version"
        ? `OpenClaw ${version} (abcdef0)\n`
        : "Options:\n  --accept-capabilities  Accept declared capabilities\n",
    );
    const installCli = vi.fn().mockResolvedValue(undefined);
    await installSmokeRuntimeCompanions({ provider: "openai", readCli, installCli });
    expect(installCli).toHaveBeenCalledExactlyOnceWith([
      "plugins",
      "install",
      `npm:@openclaw/codex@${version}`,
      "--pin",
      "--accept-capabilities",
    ]);
  });

  it("refuses an unidentifiable core version instead of installing a moving tag", async () => {
    const readCli = (args: string[]) =>
      args[0] === "--version" ? "unknown" : "  --accept-capabilities  Accept\n";
    const installCli = vi.fn();
    await expect(
      installSmokeRuntimeCompanions({ provider: "openai", readCli, installCli }),
    ).rejects.toThrow("could not resolve installed OpenClaw version");
    expect(installCli).not.toHaveBeenCalled();
  });
});

describe("Parallels Linux runtime prerequisites", () => {
  it.each([
    { nodeVersion: "26.1.0", npmExit: 0, gitExit: 0, bootstrap: false },
    { nodeVersion: "26.0.0", npmExit: 0, gitExit: 0, bootstrap: true },
    { nodeVersion: "24.14.1", npmExit: 0, gitExit: 0, bootstrap: true },
  ])("checks usable Node/npm/Git before bootstrap: %j", (scenario) => {
    const bootstrap = vi.fn();
    ensureSmokeGuestRuntime({
      runShell: (script) => {
        const nodeRunner = shellQuote(process.execPath);
        const nodeCheckRunner = shellQuote(
          'Object.defineProperty(process.versions, "node", { value: process.env.OPENCLAW_TEST_NODE_RELEASE }); eval(process.argv[1]);',
        );
        return execFileSync(
          "bash",
          [
            "-c",
            `node() { ${nodeRunner} -e ${nodeCheckRunner} "$2"; }
npm() { return ${scenario.npmExit}; }
git() { return ${scenario.gitExit}; }
${script}`,
          ],
          {
            encoding: "utf8",
            env: { ...process.env, OPENCLAW_TEST_NODE_RELEASE: scenario.nodeVersion },
            timeout: 10_000,
          },
        );
      },
      bootstrap,
    });
    expect(bootstrap).toHaveBeenCalledTimes(scenario.bootstrap ? 1 : 0);
  });
});
