import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const canonical = "FWJYW4S8P8";
const fallback = "BBBBB22222";
const script = path.resolve("scripts/ios-team-id.sh");

it.each([
  {
    name: "prefers canonical Xcode metadata",
    teams: [fallback, canonical],
    explicit: "",
    error: "",
  },
  {
    name: "rejects fallback-only Xcode metadata",
    teams: [fallback],
    explicit: "",
    error: `Official OpenClaw iOS Team ID '${canonical}' is not available`,
  },
  {
    name: "rejects an explicit fallback team",
    teams: [],
    explicit: fallback,
    error: "is not the official OpenClaw iOS team",
  },
])("$name", ({ teams, explicit, error }) => {
  const home = tempDirs.make("ios-team-id-");
  const bin = path.join(home, "bin");
  const preferences = path.join(home, "Library/Preferences");
  mkdirSync(bin);
  mkdirSync(preferences, { recursive: true });
  writeFileSync(path.join(preferences, "com.apple.dt.Xcode.plist"), "");
  const metadata = JSON.stringify({ account: teams.map((teamID) => ({ teamID })) });
  for (const [name, body] of [
    ["defaults", "exit 0"],
    [
      "plutil",
      `if [[ "$2" == IDEProvisioningTeamByIdentifier ]]; then\nprintf '%s\\n' '${metadata}'\nelse\necho '{}'\nfi`,
    ],
  ]) {
    writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}`, { mode: 0o755 });
  }
  const args = process.platform === "win32" ? [] : ["--noprofile", "--norc"];
  const result = spawnSync(
    process.platform === "win32" ? "bash" : "/bin/bash",
    [...args, script, ...(error ? ["--require-canonical"] : [])],
    {
      encoding: "utf8",
      env: {
        HOME: home,
        LANG: process.env.LANG ?? "C",
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
        IOS_PYTHON_BIN: "python3",
        IOS_DEVELOPMENT_TEAM: explicit,
      },
    },
  );
  expect(result.status, result.stderr).toBe(error ? 1 : 0);
  if (error) {
    expect(result.stderr).toContain(error);
  } else {
    expect(result.stdout.trim()).toBe(canonical);
  }
});
