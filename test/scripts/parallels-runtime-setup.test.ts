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
import type { Mode } from "../../scripts/e2e/parallels/types.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Parallels smoke controller", () => {
  it.each([
    {
      mode: "fresh",
      failFresh: false,
      json: false,
      keepServer: false,
      expectedEvents: ["fresh", "summary", "stop"],
      expectedStatus: { freshMain: "pass", upgrade: "skip" },
    },
    {
      mode: "upgrade",
      failFresh: false,
      json: true,
      keepServer: true,
      expectedEvents: ["upgrade", "summary"],
      expectedStatus: { freshMain: "skip", upgrade: "pass" },
    },
    {
      mode: "both",
      failFresh: true,
      json: true,
      keepServer: false,
      expectedEvents: ["fresh", "upgrade", "summary", "stop"],
      expectedStatus: { freshMain: "fail", upgrade: "pass" },
    },
  ] as const)("runs selected lanes and finalizes artifacts: %j", async (scenario) => {
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

      constructor(mode: Mode) {
        super({
          mode,
          json: scenario.json,
          keepServer: scenario.keepServer,
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
        if (scenario.failFresh) {
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
      await new FixtureSmoke(scenario.mode).run();
      expect(events).toEqual(scenario.expectedEvents);
      expect(stdout.mock.calls.map(([text]) => text).join("")).toBe(
        scenario.json
          ? `${JSON.stringify(scenario.expectedStatus)}\n`
          : `summary: ${path.join(root, "summary.json")}\n`,
      );
      expect(stderr.mock.calls.map(([text]) => text).join("")).toBe(
        scenario.failFresh ? "warn: fresh lane failed: fresh assertion failed\n" : "",
      );
      expect(process.exitCode).toBe(scenario.failFresh ? 1 : undefined);
      expect(existsSync(artifacts)).toBe(scenario.keepServer);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      process.exitCode = previousExitCode;
    }
  });
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

  it.each(["2026.8.1", "2026.8.1-beta.2"])(
    "pins only the reviewed runtime companion to installed candidate %s",
    async (version) => {
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
    },
  );

  it("propagates companion installation failures before onboarding can continue", async () => {
    const error = new Error("existing plugin install must not be overwritten");
    const readCli = (args: string[]) =>
      args[0] === "--version" ? "OpenClaw 2026.8.1" : "  --accept-capabilities  Accept\n";
    const installCli = vi.fn().mockRejectedValue(error);
    await expect(
      installSmokeRuntimeCompanions({ provider: "openai", readCli, installCli }),
    ).rejects.toBe(error);
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
    { nodeVersion: "24.18.0", npmExit: 0, gitExit: 0, bootstrap: false },
    { nodeVersion: "26.1.0", npmExit: 0, gitExit: 0, bootstrap: false },
    { nodeVersion: "26.0.0", npmExit: 0, gitExit: 0, bootstrap: true },
    { nodeVersion: "24.14.1", npmExit: 0, gitExit: 0, bootstrap: true },
    { nodeVersion: "23.11.0", npmExit: 0, gitExit: 0, bootstrap: true },
    { nodeVersion: "", npmExit: 0, gitExit: 0, bootstrap: true },
    { nodeVersion: "24.18.0", npmExit: 127, gitExit: 0, bootstrap: true },
    { nodeVersion: "24.18.0", npmExit: 0, gitExit: 127, bootstrap: true },
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
