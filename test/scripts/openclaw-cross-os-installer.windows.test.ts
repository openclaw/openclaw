import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LaneState } from "../../scripts/lib/cross-os-release-checks/config.ts";
import {
  buildInstallerSmokeScript,
  runCommand,
} from "../../scripts/lib/cross-os-release-checks/index.ts";
import {
  runInstallerSmoke,
  verifyFreshShellCommand,
} from "../../scripts/lib/cross-os-release-checks/installed.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function powerShellSingleQuote(value: string) {
  return value.replace(/'/gu, "''");
}

async function runPowerShell(params: {
  script: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  return runCommand(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      params.script,
    ],
    {
      check: false,
      cwd: params.cwd,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 10_000,
    },
  );
}

async function runPosixShell(params: {
  script: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  return runCommand("/bin/bash", ["-lc", params.script], {
    check: false,
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 10_000,
  });
}

function installerTempFiles(dir: string) {
  return readdirSync(dir).filter((entry) => entry.startsWith("openclaw-installer-"));
}

describe("cross-OS installer fetch", () => {
  it.runIf(process.platform !== "win32")(
    "preserves the provisioned Node PATH for installation but still verifies a fresh login shell",
    async () => {
      const dir = tempDirs.make("openclaw-installer-path-");
      const provisionedBin = join(dir, "setup-node");
      const staleBin = join(dir, "homebrew");
      const installedBin = join(dir, "installed");
      const startupMarker = join(dir, "startup.txt");
      const nodeMarker = join(dir, "node.txt");
      for (const bin of [provisionedBin, staleBin, installedBin]) {
        mkdirSync(bin);
      }
      for (const [bin, version] of [
        [provisionedBin, "v24.22.1"],
        [staleBin, "v24.21.0"],
      ] as const) {
        writeFileSync(join(bin, "node"), '#!/bin/sh\nprintf "%s\\n" "' + version + '"\n', {
          mode: 0o755,
        });
      }
      // Model login startup replacing setup-node's PATH without touching the host's profiles.
      // BASH_ENV observes the real shell mode; both launch owners and runCommand stay real.
      const bashEnv = join(dir, "bash-env");
      writeFileSync(
        bashEnv,
        [
          'export HOME="$OPENCLAW_PROOF_HOME"',
          "if shopt -q login_shell; then",
          '  export PATH="$OPENCLAW_PROOF_STALE_BIN:/usr/bin:/bin"',
          '  printf "login\\n" >> "$OPENCLAW_PROOF_STARTUP_MARKER"',
          "fi",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, ".bashrc"),
        'export PATH="$OPENCLAW_PROOF_INSTALLED_BIN:$PATH"\nprintf "bashrc\\n" >> "$OPENCLAW_PROOF_STARTUP_MARKER"\n',
      );
      const lane: LaneState = {
        name: "installer-path",
        rootDir: dir,
        prefixDir: installedBin,
        homeDir: dir,
        stateDir: dir,
        appDataDir: dir,
        gatewayPort: 0,
        phaseTimings: [],
      };
      const env = {
        PATH: provisionedBin + ":/usr/bin:/bin",
        HOME: dir,
        TMPDIR: dir,
        BASH_ENV: bashEnv,
        OPENCLAW_PROOF_HOME: dir,
        OPENCLAW_PROOF_STALE_BIN: staleBin,
        OPENCLAW_PROOF_INSTALLED_BIN: installedBin,
        OPENCLAW_PROOF_STARTUP_MARKER: startupMarker,
        OPENCLAW_PROOF_NODE_MARKER: nodeMarker,
      };
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(
          [
            "set -eu",
            'version="$(node --version)"',
            'printf "%s\\n" "$version" > "$OPENCLAW_PROOF_NODE_MARKER"',
            'echo "installer Node: $version"',
            '[ "$version" = v24.22.1 ] || exit 42',
            'printf \'#!/bin/sh\nprintf "OpenClaw proof-target\\n"\n\' > "$OPENCLAW_PROOF_INSTALLED_BIN/openclaw"',
            'chmod +x "$OPENCLAW_PROOF_INSTALLED_BIN/openclaw"',
          ].join("\n"),
        );
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Installer PATH fixture did not bind a TCP port.");
        }
        await runInstallerSmoke({
          lane,
          env,
          installerUrl: "http://127.0.0.1:" + address.port + "/install.sh",
          installTarget: "proof-target",
          logPath: join(dir, "install.log"),
        });
        expect(readFileSync(nodeMarker, "utf8")).toBe("v24.22.1\n");
        expect(existsSync(startupMarker)).toBe(false);
        expect(installerTempFiles(dir)).toEqual([]);

        const freshShell = await verifyFreshShellCommand({
          lane,
          env,
          expectedNeedle: "proof-target",
          logPath: join(dir, "fresh-shell.log"),
        });
        expect(freshShell.cliPath).toBe(join(installedBin, "openclaw"));
        expect(freshShell.versionOutput).toContain("OpenClaw proof-target");
        expect(readFileSync(startupMarker, "utf8")).toBe("login\nbashrc\n");
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    },
    15_000,
  );

  it.runIf(process.platform !== "win32")(
    "buffers POSIX installers before execution and cleans up timed-out downloads",
    async () => {
      const dir = tempDirs.make("openclaw-cross-os-installer-");
      const healthyMarker = join(dir, "healthy.txt");
      const stalledMarker = join(dir, "stalled.txt");
      const server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        if (request.url === "/healthy") {
          response.end('printf "%s" "$1|$2|$3" > "$OPENCLAW_PROOF_HEALTHY_MARKER"\n');
          return;
        }
        response.write('printf executed > "$OPENCLAW_PROOF_STALL_MARKER"\n');
      });

      try {
        await new Promise<void>((resolvePromise, rejectPromise) => {
          server.once("error", rejectPromise);
          server.listen(0, "127.0.0.1", resolvePromise);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("POSIX installer proof server did not bind to a TCP port.");
        }
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const env = {
          ...process.env,
          TMPDIR: dir,
          OPENCLAW_PROOF_HEALTHY_MARKER: healthyMarker,
          OPENCLAW_PROOF_STALL_MARKER: stalledMarker,
        };
        const timeouts = { connectTimeoutSeconds: 2, requestTimeoutSeconds: 1 };

        const healthy = await runPosixShell({
          script: buildInstallerSmokeScript(
            {
              installerUrl: `${baseUrl}/healthy`,
              installTarget: "proof-target",
              platform: "linux",
            },
            timeouts,
          ),
          cwd: dir,
          env,
          logPath: join(dir, "healthy.log"),
        });

        expect(healthy.exitCode).toBe(0);
        expect(readFileSync(healthyMarker, "utf8")).toBe("--version|proof-target|--no-onboard");
        expect(installerTempFiles(dir)).toEqual([]);

        const stalled = await runPosixShell({
          script: buildInstallerSmokeScript(
            {
              installerUrl: `${baseUrl}/stalled`,
              installTarget: "proof-target",
              platform: "linux",
            },
            timeouts,
          ),
          cwd: dir,
          env,
          logPath: join(dir, "stalled.log"),
        });

        expect(stalled.exitCode).toBe(28);
        expect(existsSync(stalledMarker)).toBe(false);
        expect(installerTempFiles(dir)).toEqual([]);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
        });
      }
    },
    15_000,
  );

  it.runIf(process.platform === "win32")(
    "times out stalled bodies without executing partial scripts or leaking temp files",
    async () => {
      const dir = tempDirs.make("openclaw-cross-os-installer-");
      const healthyMarker = join(dir, "healthy.txt");
      const stalledMarker = join(dir, "stalled.txt");
      const server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        if (request.url === "/healthy") {
          response.end(
            [
              "param([string] $Tag, [switch] $NoOnboard)",
              `[System.IO.File]::WriteAllText('${powerShellSingleQuote(healthyMarker)}', "tag=$Tag noOnboard=$($NoOnboard.IsPresent)")`,
            ].join("\n"),
          );
          return;
        }
        response.write(
          `[System.IO.File]::WriteAllText('${powerShellSingleQuote(stalledMarker)}', 'executed')\n`,
        );
      });

      try {
        await new Promise<void>((resolvePromise, rejectPromise) => {
          server.once("error", rejectPromise);
          server.listen(0, "127.0.0.1", resolvePromise);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Windows installer proof server did not bind to a TCP port.");
        }
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const env = { ...process.env, TEMP: dir, TMP: dir };
        const timeouts = { connectTimeoutSeconds: 2, requestTimeoutSeconds: 1 };

        const healthy = await runPowerShell({
          script: buildInstallerSmokeScript(
            {
              installerUrl: `${baseUrl}/healthy`,
              installTarget: "proof-target",
              platform: "win32",
            },
            timeouts,
          ),
          cwd: dir,
          env,
          logPath: join(dir, "healthy.log"),
        });

        expect(healthy.exitCode).toBe(0);
        expect(readFileSync(healthyMarker, "utf8")).toBe("tag=proof-target noOnboard=True");
        expect(installerTempFiles(dir)).toEqual([]);

        const stalled = await runPowerShell({
          script: buildInstallerSmokeScript(
            {
              installerUrl: `${baseUrl}/stalled`,
              installTarget: "proof-target",
              platform: "win32",
            },
            timeouts,
          ),
          cwd: dir,
          env,
          logPath: join(dir, "stalled.log"),
        });

        expect(stalled.exitCode).not.toBe(0);
        expect(`${stalled.stdout}\n${stalled.stderr}`).toContain("exit 28");
        expect(existsSync(stalledMarker)).toBe(false);
        expect(installerTempFiles(dir)).toEqual([]);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
        });
      }
    },
    15_000,
  );
});
