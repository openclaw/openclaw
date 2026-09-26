import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const simulatorId = "11111111-2222-3333-4444-555555555555";
const keptCategories =
  "widgets,siri,icloud,store,pim,web,health,photos,apps,messaging,connectivity,telemetry,other";
const checksum = "c7d33ba033488521eb42ec2057c3a069b13b6551c9ebfe4455128befe2ad9b19";
type Command = { tool: string; args: string[] };

function runFixture(
  script: "install-simslim.sh" | "ios-simulator-prepare.sh",
  options: {
    failure?: string;
    os?: string;
    arch?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const root = tempDirs.make("openclaw-simslim-");
  const bin = path.join(root, "bin");
  const installDir = path.join(root, "private tools");
  mkdirSync(bin);
  const runner = path.join(root, "tools.mjs");
  writeFileSync(
    runner,
    String.raw`
import { appendFileSync, copyFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const [tool, ...args] = process.argv.slice(2);
const root = process.env.SIMSLIM_FIXTURE_ROOT;
const failure = process.env.SIMSLIM_FIXTURE_FAILURE;
appendFileSync(path.join(root, "commands.jsonl"), JSON.stringify({ tool, args }) + "\n");
if (tool === "uname") {
  console.log(args[0] === "-s" ? process.env.SIMSLIM_FIXTURE_OS : process.env.SIMSLIM_FIXTURE_ARCH);
} else if (tool === "curl") {
  if (failure === "download") process.exit(23);
  writeFileSync(args[args.indexOf("--output") + 1], "fixture archive");
} else if (tool === "shasum") {
  console.log((failure === "checksum" ? "wrong" : process.env.SIMSLIM_FIXTURE_CHECKSUM) + "  " + args[2]);
  if (failure === "checksum-exit") process.exit(23);
} else if (tool === "tar") {
  if (failure === "extract") process.exit(23);
  copyFileSync(path.join(root, "bin", "simslim"), path.join(args[args.indexOf("-C") + 1], "simslim"));
} else if (tool === "simslim") {
  if (args[0] === "--version") {
    console.log(failure === "version" ? "simslim 0.9.0" : "simslim 0.8.0");
    if (failure === "version-exit") process.exit(23);
  } else if (args[0] === failure) {
    process.exit(23);
  }
} else if (tool === "xcrun" && failure === "readiness") {
  process.exit(23);
}
`,
  );
  for (const tool of ["uname", "curl", "shasum", "tar", "simslim", "xcrun"]) {
    const executable = path.join(bin, tool);
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${runner}' '${tool}' "$@"\n`);
    chmodSync(executable, 0o755);
  }
  const result = spawnSync(
    "/bin/bash",
    [
      path.resolve("scripts", script),
      ...(options.args ?? (script === "install-simslim.sh" ? [installDir] : [simulatorId])),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        TMPDIR: root,
        CI: "true",
        OPENCLAW_CI_SIMSLIM_BINARY: path.join(bin, "simslim"),
        SIMSLIM_FIXTURE_ROOT: root,
        SIMSLIM_FIXTURE_OS: options.os ?? "Darwin",
        SIMSLIM_FIXTURE_ARCH: options.arch ?? "arm64",
        SIMSLIM_FIXTURE_FAILURE: options.failure ?? "",
        SIMSLIM_FIXTURE_CHECKSUM: checksum,
        ...options.env,
      },
    },
  );
  const trace = path.join(root, "commands.jsonl");
  const commands: Command[] = existsSync(trace)
    ? readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return { result, commands, installDir };
}

describe.skipIf(process.platform === "win32")("simslim installer", () => {
  it("checks the pinned bounded download before extraction and version execution", () => {
    const { result, commands, installDir } = runFixture("install-simslim.sh");
    expect(result.status, result.stderr).toBe(0);
    expect(commands.map(({ tool }) => tool)).toEqual([
      "uname",
      "uname",
      "curl",
      "shasum",
      "tar",
      "simslim",
    ]);
    expect(commands.find(({ tool }) => tool === "curl")?.args).toEqual([
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "10",
      "--max-time",
      "120",
      "--retry",
      "3",
      "--retry-max-time",
      "120",
      "--output",
      expect.stringContaining("simslim.tar.gz"),
      "https://github.com/MobAI-App/simslim/releases/download/v0.8.0/simslim-v0.8.0-macos-arm64.tar.gz",
    ]);
    expect(commands.find(({ tool }) => tool === "shasum")?.args).toEqual([
      "-a",
      "256",
      expect.stringContaining("simslim.tar.gz"),
    ]);
    expect(commands.find(({ tool }) => tool === "tar")?.args.at(-1)).toBe("simslim");
    expect(commands.at(-1)?.args).toEqual(["--version"]);
    expect(statSync(installDir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(installDir, "simslim")).mode & 0o777).toBe(0o755);
  });

  it.each([
    ["download", "curl"],
    ["checksum", "shasum"],
    ["checksum-exit", "shasum"],
    ["extract", "tar"],
    ["version", "simslim"],
    ["version-exit", "simslim"],
  ])("stops on %s failure", (failure, lastTool) => {
    const { result, commands, installDir } = runFixture("install-simslim.sh", { failure });
    expect(result.status).not.toBe(0);
    expect(commands.at(-1)?.tool).toBe(lastTool);
    if (!failure.startsWith("version")) {
      expect(existsSync(path.join(installDir, "simslim"))).toBe(false);
    }
  });

  it.each([
    { os: "Linux", arch: "arm64" },
    { os: "Darwin", arch: "x86_64" },
  ])("rejects unsupported hosts before download: %j", (host) => {
    const { result, commands } = runFixture("install-simslim.sh", host);
    expect(result.status).toBe(1);
    expect(commands.every(({ tool }) => tool === "uname")).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("iOS simulator preparation", () => {
  it("applies and verifies the same conservative profile on the explicit simulator", () => {
    const { result, commands } = runFixture("ios-simulator-prepare.sh");
    expect(result.status, result.stderr).toBe(0);
    expect(commands).toEqual([
      { tool: "simslim", args: ["on", simulatorId, "--except", keptCategories] },
      { tool: "xcrun", args: ["simctl", "bootstatus", simulatorId, "-b"] },
      { tool: "simslim", args: ["verify", simulatorId, "--except", keptCategories] },
    ]);
  });

  it("does nothing without the opt-in, even outside CI and without a target", () => {
    const { result, commands } = runFixture("ios-simulator-prepare.sh", {
      args: [],
      env: { CI: "", OPENCLAW_CI_SIMSLIM_BINARY: "" },
    });
    expect(result.status).toBe(0);
    expect(commands).toEqual([]);
  });

  it.each([
    { env: { CI: "" } },
    { env: { OPENCLAW_CI_SIMSLIM_BINARY: "simslim" } },
    { env: { OPENCLAW_CI_SIMSLIM_BINARY: "/missing-simslim" } },
    { args: [] },
    { args: ["booted"] },
    { args: ["all"] },
    { args: [simulatorId, "extra"] },
  ])("rejects invalid admission before any tool call: %j", (options) => {
    const { result, commands } = runFixture("ios-simulator-prepare.sh", options);
    expect(result.status).not.toBe(0);
    expect(commands).toEqual([]);
  });

  it.each([
    ["on", 1],
    ["readiness", 2],
    ["verify", 3],
  ] as const)("preserves %s failure without subsequent calls", (failure, count) => {
    const { result, commands } = runFixture("ios-simulator-prepare.sh", { failure });
    expect(result.status).toBe(23);
    expect(commands).toHaveLength(count);
  });
});
