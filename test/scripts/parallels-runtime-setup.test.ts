import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { shellQuote } from "../../scripts/e2e/parallels/host-command.ts";
import {
  ensureSmokeGuestRuntime,
  installSmokeRuntimeCompanions,
  SmokeRunController,
  type SmokeCliOptions,
} from "../../scripts/e2e/parallels/smoke-common.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
    const stop = async () => {
      events.push("stop");
      throw new Error("server already stopped");
    };
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

const companionHelp = "  --accept-capabilities  Accept declared capabilities\n";
const legacyHelp = "  --pin  Pin resolved version\n";
const helpArgs = ["plugins", "install", "--help"];
const candidateVersion = "2026.8.1-beta.2";
it.each([
  ["anthropic", "", "", 0],
  ["openai", legacyHelp, "", 1],
  ["openai", companionHelp, candidateVersion, 2],
  ["openai", companionHelp, "unknown", 2],
] as const)(
  "sets up %s companions with help %j and version %s",
  async (provider, help, version, reads) => {
    const versionOutput =
      version === candidateVersion ? `OpenClaw ${version} (abcdef0)\n` : version;
    const readCli = vi.fn().mockReturnValueOnce(help).mockReturnValueOnce(versionOutput);
    const installCli = vi.fn();
    const result = installSmokeRuntimeCompanions({ provider, readCli, installCli });
    if (version === "unknown") {
      await expect(result).rejects.toThrow("could not resolve installed OpenClaw version");
    } else {
      await expect(result).resolves.toBeUndefined();
    }
    expect(readCli.mock.calls).toEqual([[helpArgs], [["--version"]]].slice(0, reads));
    const packageSpec = `npm:@openclaw/codex@${candidateVersion}`;
    const install = ["plugins", "install", packageSpec, "--pin", "--accept-capabilities"];
    expect(installCli.mock.calls).toEqual(version === candidateVersion ? [[install]] : []);
  },
);

it.each([
  ["26.12.1", false],
  ["26.12.0", true],
  ["26.1.0", true],
  ["24.22.1", false],
  ["24.22.0", true],
  ["26.0.0", true],
  ["24.14.1", true],
] as const)("checks Node %s before bootstrap", (nodeVersion, needsBootstrap) => {
  const bootstrap = vi.fn();
  ensureSmokeGuestRuntime({
    runShell: (script) =>
      execFileSync(
        "bash",
        [
          "-c",
          `node() { ${shellQuote(process.execPath)} -e ${shellQuote('Object.defineProperty(process.versions, "node", { value: process.env.OPENCLAW_TEST_NODE_RELEASE }); eval(process.argv[1]);')} "$2"; }
npm() { return 0; }
git() { return 0; }
${script}`,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, OPENCLAW_TEST_NODE_RELEASE: nodeVersion },
          timeout: 10_000,
        },
      ),
    bootstrap,
  });
  expect(bootstrap).toHaveBeenCalledTimes(needsBootstrap ? 1 : 0);
});
