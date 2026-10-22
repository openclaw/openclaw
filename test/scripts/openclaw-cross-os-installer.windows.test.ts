import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  buildInstallerSmokeScript,
  runCommand,
} from "../../scripts/lib/cross-os-release-checks/index.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const windows = process.platform === "win32";

function installerTempFiles(dir: string) {
  return readdirSync(dir).filter((entry) => entry.startsWith("openclaw-installer-"));
}

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Installer proof server did not bind to a TCP port.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createServer>) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function installer(baseUrl: string, route: string, platform: "linux" | "win32") {
  return buildInstallerSmokeScript(
    { installerUrl: `${baseUrl}/${route}`, installTarget: "proof-target", platform },
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
    const baseUrl = await listen(server);
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
    if (!windows) {
      const healthy = await runShell(
        installer(baseUrl, "healthy", "linux"),
        dir,
        env,
        join(dir, "healthy.log"),
      );
      expect(healthy.exitCode).toBe(0);
      expect(readFileSync(healthyMarker, "utf8")).toBe("--version|proof-target|--no-onboard");
      expect(installerTempFiles(dir)).toEqual([]);
    }
    const result = await runShell(
      windows
        ? [
            "[Console]::Out.WriteLine('OPENCLAW_INSTALLER_PROOF:started ' + [DateTime]::UtcNow.ToString('O'))",
            installer(baseUrl, "healthy", "win32"),
            "if (-not $?) { throw 'Healthy installer command failed' }",
            "[Console]::Out.WriteLine('OPENCLAW_INSTALLER_PROOF:healthy-complete ' + [DateTime]::UtcNow.ToString('O'))",
            installer(baseUrl, "stalled", "win32"),
          ].join("\n")
        : installer(baseUrl, "stalled", "linux"),
      dir,
      env,
      logPath,
    );

    if (windows) {
      expect(result.stdout, result.stderr).toContain("OPENCLAW_INSTALLER_PROOF:healthy-complete ");
      expect(readFileSync(healthyMarker, "utf8")).toBe("tag=proof-target noOnboard=True");
      expect(requests).toEqual(["/healthy", "/stalled"]);
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("exit 28");
    } else {
      expect(result.exitCode).toBe(28);
    }
    expect(existsSync(stalledMarker)).toBe(false);
    // Each installer uses a distinct GUID, so the final inventory covers both cleanups.
    expect(installerTempFiles(dir)).toEqual([]);
  } finally {
    await close(server);
  }
}, 15_000);
