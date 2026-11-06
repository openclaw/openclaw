import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { LaneState } from "../../scripts/lib/cross-os-release-checks/config.ts";
import {
  buildInstallerSmokeScript,
  runCommand,
} from "../../scripts/lib/cross-os-release-checks/index.ts";
import {
  runInstallerSmoke,
  verifyFreshShellCommand,
} from "../../scripts/lib/cross-os-release-checks/installed.ts";
import { closeHttpServer, listenLoopback } from "../helpers/gateway-integration-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const windows = process.platform === "win32";

function installerTempFiles(dir: string) {
  return readdirSync(dir).filter((entry) => entry.startsWith("openclaw-installer-"));
}

function installer(baseUrl: string, route: string) {
  return buildInstallerSmokeScript(
    {
      installerUrl: `${baseUrl}/${route}`,
      installTarget: "proof-target",
      platform: windows ? "win32" : "linux",
    },
    { connectTimeoutSeconds: 2, requestTimeoutSeconds: 1 },
  );
}

function runShell(script: string, cwd: string, env: NodeJS.ProcessEnv, logPath: string) {
  return runCommand(
    windows ? "powershell.exe" : "/bin/bash",
    windows
      ? [
          ..."-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command".split(" "),
          script,
        ]
      : ["-lc", script],
    { check: false, cwd, env, logPath, timeoutMs: 10_000 },
  );
}

it("buffers installers before execution and cleans up timed-out downloads", async () => {
  const dir = tempDirs.make("openclaw-cross-os-installer-");
  const healthyMarker = join(dir, "healthy.txt");
  const stalledMarker = join(dir, "stalled.txt");
  const logPath = join(dir, "installer.log");
  const requests: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    if (request.url === "/healthy") {
      response.end(
        windows
          ? [
              "param([string] $Tag, [switch] $NoOnboard)",
              `[System.IO.File]::WriteAllText('${healthyMarker.replace(/'/gu, "''")}', "tag=$Tag noOnboard=$($NoOnboard.IsPresent)")`,
            ].join("\n")
          : 'printf "%s" "$1|$2|$3" > "$OPENCLAW_PROOF_HEALTHY_MARKER"\n',
      );
      return;
    }
    response.write(
      windows
        ? `[System.IO.File]::WriteAllText('${stalledMarker.replace(/'/gu, "''")}', 'executed')\n`
        : 'printf executed > "$OPENCLAW_PROOF_STALL_MARKER"\n',
    );
  });

  try {
    const baseUrl = await listenLoopback(server);
    const env = {
      ...process.env,
      ...(windows
        ? { TEMP: dir, TMP: dir }
        : {
            TMPDIR: dir,
            OPENCLAW_PROOF_HEALTHY_MARKER: healthyMarker,
            OPENCLAW_PROOF_STALL_MARKER: stalledMarker,
          }),
    };
    const scripts = [installer(baseUrl, "healthy"), installer(baseUrl, "stalled")];
    const result = await runShell(
      windows
        ? scripts.join("\nif (-not $?) { throw 'Healthy installer command failed' }\n")
        : // Each POSIX installer owns an EXIT trap; subshells keep their cleanup separate.
          ["set -e", ...scripts.map((script) => `(\n${script}\n)`)].join("\n"),
      dir,
      env,
      logPath,
    );

    expect(readFileSync(healthyMarker, "utf8")).toBe(
      windows ? "tag=proof-target noOnboard=True" : "--version|proof-target|--no-onboard",
    );
    expect(requests).toEqual(["/healthy", "/stalled"]);
    if (windows) {
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("exit 28");
    } else {
      expect(result.exitCode).toBe(28);
    }
    expect(existsSync(stalledMarker)).toBe(false);
    // Each installer uses a distinct GUID, so the final inventory covers both cleanups.
    expect(installerTempFiles(dir)).toEqual([]);
  } finally {
    await closeHttpServer(server);
  }
}, 15_000);

it.runIf(!windows)(
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
      writeFileSync(join(bin, "node"), `#!/bin/sh\nprintf "%s\\n" "${version}"\n`, {
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
      PATH: `${provisionedBin}:/usr/bin:/bin`,
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
          '[ "$version" = v24.22.1 ] || exit 42',
          'printf \'#!/bin/sh\nprintf "OpenClaw proof-target\\n"\n\' > "$OPENCLAW_PROOF_INSTALLED_BIN/openclaw"',
          'chmod +x "$OPENCLAW_PROOF_INSTALLED_BIN/openclaw"',
        ].join("\n"),
      );
    });

    try {
      const baseUrl = await listenLoopback(server);
      await runInstallerSmoke({
        lane,
        env,
        installerUrl: `${baseUrl}/install.sh`,
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
      await closeHttpServer(server);
    }
  },
  15_000,
);
