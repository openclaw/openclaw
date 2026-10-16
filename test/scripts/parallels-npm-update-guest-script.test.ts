import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { NpmUpdateSmoke, parseArgs } from "../../scripts/e2e/parallels/npm-update-smoke.ts";
import { scriptProcessEntrypoints } from "../../scripts/script-process-runtime.test-support.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { withEnvAsync } from "../../src/test-utils/env.js";
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

function guestFixture() {
  const root = tempDirs.make("openclaw-parallels-npm-update-");
  const file = (name: string) => path.join(root, name);
  return {
    read: (name: string) => readFileSync(file(name), "utf8"),
    exists: (name: string) => existsSync(file(name)),
    install: (commands: Record<string, string>, fallback = 1) =>
      writeFileSync(
        file("prlctl"),
        `#!/usr/bin/env bash
set -euo pipefail
log_path=${JSON.stringify(file("prlctl.log"))}
guest_script=${JSON.stringify(file("guest-script"))}
uploaded_script=${JSON.stringify(file("uploaded-script"))}
run_args=${JSON.stringify(file("run-args"))}
printf '%s\\n' "$*" >>"$log_path"
args=" $* "
case "$args" in
${Object.entries(commands)
  .map(([command, body]) => `*${JSON.stringify(command)}*)\n${body}\nexit 0 ;;`)
  .join("\n")}
*) exit ${fallback} ;;
esac
`,
        { mode: 0o755 },
      ),
    run: <T>(callback: () => Promise<T> | T) =>
      withEnvAsync(
        {
          OPENAI_API_KEY: "test-key",
          PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        callback,
      ),
  };
}

it.runIf(process.platform !== "win32")("uses the selected Windows VM", async () => {
  const f = guestFixture();
  f.install({
    "": 'printf "%s|%s|%s\\n" "$1" "$2" "$3" >"$log_path"\ncat >/dev/null\nexit 7',
  });
  await f.run(async () => {
    const smoke = new NpmUpdateSmoke({ ...parseArgs([]), windowsVm: "Windows Test Guest" });
    await expect(
      smoke["guestWindows"]("Write-Output update", 180_000, {
        append: () => undefined,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("background script write failed");
  });
  expect(f.read("prlctl.log")).toBe("exec|Windows Test Guest|--current-user\n");
});

it.each(["write", "chmod"] as const)(
  "removes guest update scripts when %s fails",
  async (phase) => {
    const f = guestFixture();
    const prefix = "openclaw-parallels-npm-update-linux";
    f.install({
      [` /usr/bin/tee /tmp/${prefix}-`]: `head -c ${phase === "write" ? 4 : 11} >"$guest_script"
cp "$guest_script" "$uploaded_script"
${phase === "write" ? 'printf "write denied\\n" >&2; exit 7' : ""}`,
      [` /bin/chmod 755 /tmp/${prefix}-`]: 'echo "chmod denied" >&2; exit 7',
      [` /bin/rm -f /tmp/${prefix}-`]: 'printf "cleanup\\n" >>"$log_path"\nrm -f "$guest_script"',
    });
    await f.run(() => {
      const smoke = new NpmUpdateSmoke(smokeOptions());

      expect(() => smoke["writeGuestScript"]("Linux VM", "echo update", prefix)).toThrow(
        new RegExp(`failed to ${phase} guest script .+: ${phase} denied`),
      );
    });

    const log = f.read("prlctl.log");
    expect(f.read("uploaded-script")).toBe(phase === "write" ? "echo" : "echo update");
    expect(f.exists("guest-script")).toBe(false);
    expect(log.includes("/bin/chmod 755 /tmp/openclaw-parallels-npm-update-linux-")).toBe(
      phase === "chmod",
    );
    expect(log).toContain("/bin/rm -f /tmp/openclaw-parallels-npm-update-linux-");
    expect(log.match(/^cleanup$/gm)).toHaveLength(1);
  },
);

it.each([0, 7, "chown"] as const)(
  "keeps macOS guest identity through outcome %s and cleanup",
  async (outcome) => {
    const chownFailed = outcome === "chown";
    const exitCode = chownFailed ? 0 : outcome;
    const f = guestFixture();
    f.install({
      " --current-user whoami ": "printf 'desktop-user\\n'",
      " /usr/bin/tee /tmp/openclaw-parallels-npm-update-macos-":
        'tee "$uploaded_script" >"$guest_script"',
      " /bin/chmod 700 /tmp/openclaw-parallels-npm-update-macos-": "",
      " /usr/sbin/chown desktop-user /tmp/openclaw-parallels-npm-update-macos-": chownFailed
        ? 'printf "chown denied\\n" >&2; exit 7'
        : "",
      " /bin/bash /tmp/openclaw-parallels-npm-update-macos-": `printf '%s\\0' "$@" >"$run_args"
printf 'update-output\\n'
printf 'update-diagnostic\\n' >&2
exit ${exitCode}`,
      " /bin/rm -f /tmp/openclaw-parallels-npm-update-macos-": 'rm -f "$guest_script"',
    });
    const output: string[] = [];

    await f.run(async () => {
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
        signal: new AbortController().signal,
      });
      if (exitCode === 0) {
        await expect(result).resolves.toBeUndefined();
      } else {
        await expect(result).rejects.toThrow(
          `macOS update command failed with exit code ${exitCode}`,
        );
      }
    });

    if (chownFailed) {
      expect(f.exists("run-args")).toBe(false);
    } else {
      expect(f.read("run-args").split("\0").slice(0, -1)).toEqual([
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
    expect(f.read("uploaded-script")).toBe("echo update");
    expect(f.exists("guest-script")).toBe(false);
    const log = f.read("prlctl.log");
    expect(log).toContain("--current-user whoami");
    expect(log).toContain("/usr/bin/tee /tmp/openclaw-parallels-npm-update-macos-");
    expect(log).toContain("/bin/chmod 700 /tmp/openclaw-parallels-npm-update-macos-");
    expect(log).toContain("/usr/sbin/chown desktop-user");
    expect(
      log.match(/\/bin\/bash \/tmp\/openclaw-parallels-npm-update-macos-/g) ?? [],
    ).toHaveLength(chownFailed ? 0 : 1);
    expect(log.match(/\/bin\/rm -f \/tmp\/openclaw-parallels-npm-update-macos-/g)).toHaveLength(1);
    expect(log.trim().split("\n").at(-1)).toMatch(
      /^exec macOS Tahoe \/bin\/rm -f \/tmp\/openclaw-parallels-npm-update-macos-/,
    );
  },
);

it.each<[string, Record<string, string>, string]>([
  [
    "user",
    {
      " /usr/bin/stat -f %Su /dev/console": "printf '%s\\n' 'loginwindow'",
      " /usr/bin/dscl . -list /Users NFSHomeDirectory":
        "printf '%s\\n' '_daemon /var/root' 'clawuser /Volumes/Macintosh HD/Users/clawuser'",
    },
    "clawuser",
  ],
  [
    "home",
    {
      " /usr/bin/dscl . -read /Users/clawuser NFSHomeDirectory":
        "printf '%s\\n' 'NFSHomeDirectory: /Volumes/Macintosh HD/Users/clawuser'",
    },
    "/Volumes/Macintosh HD/Users/clawuser",
  ],
])("resolves macOS desktop %s on spaced volumes", async (field, commands, expected) => {
  const f = guestFixture();
  f.install(commands, 7);
  await f.run(() => {
    const smoke = new NpmUpdateSmoke(smokeOptions("macos"));
    const actual =
      field === "user"
        ? smoke["resolveMacosDesktopUser"]()
        : smoke["resolveMacosDesktopHome"]("clawuser");
    expect(actual).toBe(expected);
  });
});
