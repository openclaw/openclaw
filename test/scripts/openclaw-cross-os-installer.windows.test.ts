import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  buildInstallerSmokeScript,
  runCommand,
} from "../../scripts/lib/cross-os-release-checks/index.ts";
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
