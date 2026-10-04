import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NpmUpdateSmoke, parseArgs } from "../../scripts/e2e/parallels/npm-update-smoke.ts";
import { scriptProcessEntrypoints } from "../../scripts/script-process-runtime.test-support.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { withEnv, withEnvAsync } from "../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function smokeOptions(platform: "linux" | "macos" = "linux") {
  return parseArgs([
    "--platform",
    platform,
    "--model",
    "gpt-5.4",
    "--api-key-env",
    "OPENAI_API_KEY",
    "--package-spec",
    "openclaw@latest",
    "--update-target",
    "local-main",
  ]);
}

describe("Parallels npm update guest scripts", () => {
  it.runIf(process.platform !== "win32")(
    "uses the selected Windows VM for same-guest update transport",
    async () => {
      const root = tempDirs.make("openclaw-parallels-windows-selection-");
      const logPath = path.join(root, "prlctl.log");
      const prlctlPath = path.join(root, "prlctl");
      writeFileSync(
        prlctlPath,
        `#!/usr/bin/env bash\nprintf '%s|%s|%s\\n' "$1" "$2" "$3" >'${logPath}'\ncat >/dev/null\nexit 7\n`,
      );
      chmodSync(prlctlPath, 0o755);

      await withEnvAsync(
        { OPENAI_API_KEY: "test-key", PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}` },
        async () => {
          const smoke = new NpmUpdateSmoke({ ...parseArgs([]), windowsVm: "Windows Test Guest" });
          const guestWindows = Reflect.get(smoke, "guestWindows") as (
            script: string,
            timeoutMs: number,
            ctx: { append: (chunk: string) => void },
          ) => Promise<void>;
          await expect(
            guestWindows.call(smoke, "Write-Output update", 180_000, { append: () => undefined }),
          ).rejects.toThrow("background script write failed");
        },
      );
      expect(readFileSync(logPath, "utf8")).toBe("exec|Windows Test Guest|--current-user\n");
    },
  );

  it.each(["write", "chmod"] as const)("removes guest update scripts when %s fails", (phase) => {
    const root = tempDirs.make("openclaw-parallels-npm-update-");
    const logPath = path.join(root, "prlctl.log");
    const guestScriptPath = path.join(root, "guest-script");
    const uploadedScriptPath = path.join(root, "uploaded-script");
    const prlctlPath = path.join(root, "prlctl");
    writeFileSync(
      prlctlPath,
      `#!/usr/bin/env bash
set -euo pipefail
log_path=${JSON.stringify(logPath)}
printf '%s\\n' "$*" >>"$log_path"
args=" $* "
if [[ "$args" == *" /usr/bin/tee /tmp/openclaw-parallels-npm-update-linux-"* ]]; then
  head -c ${phase === "write" ? 4 : 11} >${JSON.stringify(guestScriptPath)}
  cp ${JSON.stringify(guestScriptPath)} ${JSON.stringify(uploadedScriptPath)}
  ${phase === "write" ? 'printf "write denied\\n" >&2; exit 7' : "exit 0"}
fi
if [[ "$args" == *" /bin/chmod 755 /tmp/openclaw-parallels-npm-update-linux-"* ]]; then
  echo "chmod denied" >&2
  exit 7
fi
if [[ "$args" == *" /bin/rm -f /tmp/openclaw-parallels-npm-update-linux-"* ]]; then
  printf 'cleanup\\n' >>"$log_path"
  rm -f ${JSON.stringify(guestScriptPath)}
  exit 0
fi
exit 1
`,
    );
    chmodSync(prlctlPath, 0o755);

    withEnv(
      {
        OPENAI_API_KEY: "test-key",
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      () => {
        const smoke = new NpmUpdateSmoke(smokeOptions());

        expect(() =>
          smoke["writeGuestScript"](
            "Linux VM",
            "echo update",
            "openclaw-parallels-npm-update-linux",
          ),
        ).toThrow(new RegExp(`failed to ${phase} guest script .+: ${phase} denied`));
      },
    );

    const log = readFileSync(logPath, "utf8");
    expect(readFileSync(uploadedScriptPath, "utf8")).toBe(
      phase === "write" ? "echo" : "echo update",
    );
    expect(existsSync(guestScriptPath)).toBe(false);
    expect(log.includes("/bin/chmod 755 /tmp/openclaw-parallels-npm-update-linux-")).toBe(
      phase === "chmod",
    );
    expect(log).toContain("/bin/rm -f /tmp/openclaw-parallels-npm-update-linux-");
    expect(log.match(/^cleanup$/gm)).toHaveLength(1);
  });

  it.each([0, 7, "chown"] as const)(
    "uses one macOS guest identity through upload, outcome %s, and cleanup",
    async (outcome) => {
      const chownFailed = outcome === "chown";
      const exitCode = chownFailed ? 0 : outcome;
      const root = tempDirs.make("openclaw-parallels-npm-update-");
      const logPath = path.join(root, "prlctl.log");
      const runArgsPath = path.join(root, "run-args");
      const uploadedScriptPath = path.join(root, "uploaded-script");
      const guestScriptPath = path.join(root, "guest-script");
      const prlctlPath = path.join(root, "prlctl");
      writeFileSync(
        prlctlPath,
        `#!/usr/bin/env bash
set -euo pipefail
log_path=${JSON.stringify(logPath)}
printf '%s\\n' "$*" >>"$log_path"
args=" $* "
if [[ "$args" == *" --current-user whoami "* ]]; then
  printf 'desktop-user\\n'
  exit 0
fi
if [[ "$args" == *" /usr/bin/tee /tmp/openclaw-parallels-npm-update-macos-"* ]]; then
  tee ${JSON.stringify(uploadedScriptPath)} >${JSON.stringify(guestScriptPath)}
  exit 0
fi
if [[ "$args" == *" /bin/chmod 700 /tmp/openclaw-parallels-npm-update-macos-"* ]]; then
  exit 0
fi
if [[ "$args" == *" /usr/sbin/chown desktop-user /tmp/openclaw-parallels-npm-update-macos-"* ]]; then
  ${chownFailed ? 'printf "chown denied\\n" >&2; exit 7' : "exit 0"}
fi
if [[ "$args" == *" /bin/bash /tmp/openclaw-parallels-npm-update-macos-"* ]]; then
  printf '%s\\0' "$@" >${JSON.stringify(runArgsPath)}
  printf 'update-output\\n'
  printf 'update-diagnostic\\n' >&2
  exit ${exitCode}
fi
if [[ "$args" == *" /bin/rm -f /tmp/openclaw-parallels-npm-update-macos-"* ]]; then
  rm -f ${JSON.stringify(guestScriptPath)}
  exit 0
fi
exit 1
`,
      );
      chmodSync(prlctlPath, 0o755);
      const output: string[] = [];

      await withEnvAsync(
        {
          OPENAI_API_KEY: "test-key",
          PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        async () => {
          if (chownFailed) {
            const entry = resolveRuntimeWorkerUrl(scriptProcessEntrypoints.npmUpdateSmoke);
            const options = smokeOptions("macos");
            const result = spawnSync(
              process.execPath,
              [
                ...resolveRuntimeWorkerArgv(entry).slice(0, -1),
                "--input-type=module",
                "--eval",
                `const { NpmUpdateSmoke } = await import(${JSON.stringify(entry.href)});
const options = ${JSON.stringify(options)};
options.platforms = new Set(["macos"]);
await new NpmUpdateSmoke(options)["guestMacos"]("echo update", 30_000, {
  append() {},
  logPath: ${JSON.stringify(path.join(root, "update.log"))},
  signal: new AbortController().signal,
});`,
              ],
              { encoding: "utf8", env: process.env, timeout: 10_000 },
            );
            expect(result.status, result.stderr).toBe(1);
            expect(result.stderr).toContain("chown denied\n");
            expect(result.stderr).toMatch(
              /error: command failed \(7\): [^\n]+ exec macOS Tahoe \/usr\/sbin\/chown desktop-user \/tmp\/openclaw-parallels-npm-update-macos-/,
            );
            return;
          }
          const smoke = new NpmUpdateSmoke(smokeOptions("macos"));
          const result = smoke["guestMacos"]("echo update", 30_000, {
            append: (chunk) =>
              output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")),
            logPath: path.join(root, "update.log"),
            signal: new AbortController().signal,
          });
          if (exitCode === 0) {
            await expect(result).resolves.toBeUndefined();
          } else {
            await expect(result).rejects.toThrow(
              `macOS update command failed with exit code ${exitCode}`,
            );
          }
        },
      );

      if (chownFailed) {
        expect(existsSync(runArgsPath)).toBe(false);
      } else {
        expect(readFileSync(runArgsPath, "utf8").split("\0").slice(0, -1)).toEqual([
          "exec",
          "macOS Tahoe",
          "--current-user",
          "/usr/bin/env",
          expect.stringMatching(/^PATH=/),
          "/bin/bash",
          expect.stringMatching(/^\/tmp\/openclaw-parallels-npm-update-macos-/),
        ]);
        expect(output.join("")).toContain("update-output\n");
        expect(output.join("")).toContain("update-diagnostic\n");
      }
      expect(readFileSync(uploadedScriptPath, "utf8")).toBe("echo update");
      expect(existsSync(guestScriptPath)).toBe(false);
      const log = readFileSync(logPath, "utf8");
      expect(log).toContain("--current-user whoami");
      expect(log).toContain("/usr/bin/tee /tmp/openclaw-parallels-npm-update-macos-");
      expect(log).toContain("/bin/chmod 700 /tmp/openclaw-parallels-npm-update-macos-");
      expect(log).toContain("/usr/sbin/chown desktop-user");
      expect(
        log.match(/\/bin\/bash \/tmp\/openclaw-parallels-npm-update-macos-/g) ?? [],
      ).toHaveLength(chownFailed ? 0 : 1);
      expect(log.match(/\/bin\/rm -f \/tmp\/openclaw-parallels-npm-update-macos-/g)).toHaveLength(
        1,
      );
      expect(log.trim().split("\n").at(-1)).toMatch(
        /^exec macOS Tahoe \/bin\/rm -f \/tmp\/openclaw-parallels-npm-update-macos-/,
      );
    },
  );

  it.each([
    {
      field: "user",
      script: `if [[ "$args" == *" /usr/bin/stat -f %Su /dev/console"* ]]; then
  printf '%s\\n' 'loginwindow'
  exit 0
fi
if [[ "$args" == *" /usr/bin/dscl . -list /Users NFSHomeDirectory"* ]]; then
  printf '%s\\n' '_daemon /var/root'
  printf '%s\\n' 'clawuser /Volumes/Macintosh HD/Users/clawuser'
  exit 0
fi`,
      expected: "clawuser",
    },
    {
      field: "home",
      script: `if [[ "$args" == *" /usr/bin/dscl . -read /Users/clawuser NFSHomeDirectory"* ]]; then
  printf '%s\\n' 'NFSHomeDirectory: /Volumes/Macintosh HD/Users/clawuser'
  exit 0
fi`,
      expected: "/Volumes/Macintosh HD/Users/clawuser",
    },
  ] as const)(
    "resolves macOS desktop $field on spaced mounted volumes",
    ({ field, script, expected }) => {
      const root = tempDirs.make("openclaw-parallels-npm-update-");
      const prlctlPath = path.join(root, "prlctl");
      writeFileSync(
        prlctlPath,
        `#!/usr/bin/env bash
set -euo pipefail
args=" $* "
${script}
exit 7
`,
      );
      chmodSync(prlctlPath, 0o755);

      withEnv(
        {
          OPENAI_API_KEY: "test-key",
          PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        () => {
          const smoke = new NpmUpdateSmoke(smokeOptions("macos"));
          const actual =
            field === "user"
              ? smoke["resolveMacosDesktopUser"]()
              : smoke["resolveMacosDesktopHome"]("clawuser");
          expect(actual).toBe(expected);
        },
      );
    },
  );
});
