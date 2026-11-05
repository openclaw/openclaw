import { spawnSync } from "node:child_process";

export function runStreamedInstallerHelp(bash: string, script: string, tmp: string) {
  return spawnSync(bash, ["-s", "--", "--help"], {
    input: script,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      HOME: tmp,
      TMPDIR: tmp,
      BASH_ENV: "",
      ENV: "",
      OPENCLAW_INSTALL_SH_NO_RUN: "0",
      OPENCLAW_INSTALL_CLI_SH_NO_RUN: "0",
    },
  });
}

export function findDarwinReexecBash(): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  for (const binary of ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "bash"]) {
    const result = spawnSync(
      binary,
      ["-c", 'printf "%s.%s" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"'],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: { ...process.env, BASH_ENV: "", ENV: "" },
      },
    );
    const [major = 0, minor = 0] = result.stdout?.split(".").map(Number) ?? [];
    if (result.status === 0 && (major > 5 || (major === 5 && minor >= 3))) {
      return binary;
    }
  }
  return undefined;
}
