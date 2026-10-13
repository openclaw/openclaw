import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const helperPath = ".github/actions/setup-node-env/seed-bun-from-image.mjs";
const pins = {
  "linux-x64": "36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913",
  "linux-x64-baseline": "c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f",
};
type Variant = keyof typeof pins;
type Step = { name: string; run?: string; if?: string };
const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8")) as {
  runs: { steps: Step[] };
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bun-image-"));
  roots.push(root);
  const image = join(root, "image");
  const runnerTemp = join(root, "runner");
  const actionPath = join(root, "action");
  const nodeBin = join(root, "node-bin");
  const cpu = join(root, "cpuinfo");
  const npmLog = join(root, "npm.log");
  const bunLog = join(root, "bun.log");
  for (const directory of [image, runnerTemp, actionPath, nodeBin]) {
    mkdirSync(directory);
  }
  writeFileSync(cpu, "");
  const shell = (path: string, body: string) =>
    writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
  shell(
    join(nodeBin, "node"),
    `if [[ "$*" == "-p process.execPath" ]]; then
  printf '%s/node\\n' "$FIXTURE_NODE_BIN"
else
  exec "$FIXTURE_REAL_NODE" "$@"
fi`,
  );
  shell(
    join(nodeBin, "npm"),
    `if [[ "$*" == "-v" ]]; then
  echo fixture-npm
else
  printf '%s\\n' "$*" >> "$FIXTURE_NPM_LOG"
  [[ "$*" == "install -g bun@1.4.2" ]]
  cp "$FIXTURE_FALLBACK" "$FIXTURE_NODE_BIN/bun"
fi`,
  );
  shell(join(nodeBin, "pnpm"), "echo fixture-pnpm");
  shell(join(nodeBin, "bun"), "echo stale-node-bun");
  symlinkSync("bun", join(nodeBin, "bunx"));
  shell(join(root, "fallback-bun"), "echo npm-fallback-bun");
  const hashes = new Map<Variant, string>();
  function archive(variant: Variant, version = "1.4.2", member = `bun-${variant}/bun`) {
    const stage = join(root, `stage-${variant}`);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(join(stage, member, ".."), { recursive: true });
    shell(
      join(stage, member),
      `echo ${variant} >> "$FIXTURE_BUN_LOG"
if [[ "\${1:-}" == "--version" || "\${1:-}" == "-v" ]]; then
  echo ${version}
else
  echo ${variant}
fi`,
    );
    const path = join(image, `bun-v1.4.2-${variant}.zip`);
    rmSync(path, { force: true });
    execFileSync("zip", ["-q", path, member], { cwd: stage });
    hashes.set(variant, createHash("sha256").update(readFileSync(path)).digest("hex"));
    return path;
  }
  for (const variant of Object.keys(pins) as Variant[]) {
    archive(variant);
  }
  const scriptPath = join(actionPath, "seed-bun-from-image.mjs");
  function prepareHelper() {
    if (!existsSync(helperPath)) {
      return;
    }
    // Only the trusted fixture substitutes host facts and source-owned digest anchors.
    let source = readFileSync(helperPath, "utf8")
      .replaceAll("/opt/crabbox/toolchain-archives", image)
      .replaceAll("/proc/cpuinfo", cpu)
      .replaceAll("process.platform", '"linux"')
      .replaceAll("process.arch", '"x64"')
      .replaceAll("process.report.getReport().header.glibcVersionRuntime", '"2.39"');
    for (const variant of Object.keys(pins) as Variant[]) {
      const hash = hashes.get(variant);
      if (!hash || !source.includes(pins[variant])) {
        throw new Error(`Missing fixture digest anchor for ${variant}`);
      }
      source = source.replace(pins[variant], hash);
    }
    writeFileSync(scriptPath, source);
  }
  const env = {
    HOME: root,
    PATH: `${nodeBin}:/usr/bin:/bin`,
    RUNNER_TEMP: runnerTemp,
    GITHUB_ACTION_PATH: actionPath,
    FIXTURE_REAL_NODE: process.execPath,
    FIXTURE_NODE_BIN: nodeBin,
    FIXTURE_NPM_LOG: npmLog,
    FIXTURE_BUN_LOG: bunLog,
    FIXTURE_FALLBACK: join(root, "fallback-bun"),
  };
  const log = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").trim() : "");
  function runAction() {
    prepareHelper();
    const additions: string[] = [];
    const jobEnv: Record<string, string> = { ...env };
    const runs = new Map<string, SpawnSyncReturns<string>>();
    function step(name: string, body: string) {
      const githubPath = join(root, "github-path");
      const githubEnv = join(root, "github-env");
      writeFileSync(githubPath, "");
      writeFileSync(githubEnv, "");
      const result = spawnSync(
        "/bin/bash",
        ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", body],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...jobEnv,
            PATH: [...additions.toReversed(), env.PATH].join(":"),
            GITHUB_PATH: githubPath,
            GITHUB_ENV: githubEnv,
          },
        },
      );
      runs.set(name, result);
      for (const line of readFileSync(githubPath, "utf8").split("\n").filter(Boolean)) {
        const old = additions.indexOf(line);
        if (old !== -1) {
          additions.splice(old, 1);
        }
        additions.push(line);
      }
      for (const line of readFileSync(githubEnv, "utf8").split("\n").filter(Boolean)) {
        const equals = line.indexOf("=");
        jobEnv[line.slice(0, equals)] = line.slice(equals + 1);
      }
      return result;
    }
    for (const entry of action.runs.steps) {
      if (!["Capture node path", "Setup Bun", "Runtime versions"].includes(entry.name)) {
        continue;
      }
      if (entry.if) {
        expect(entry.if).toBe("inputs.install-bun == 'true'");
      }
      if (!entry.run) {
        throw new Error(`Missing executable block for ${entry.name}`);
      }
      const result = step(
        entry.name,
        entry.name === "Setup Bun"
          ? `${entry.run}\ncommand -v bun\ncommand -v bunx\nbun --fixture\nbunx --fixture`
          : entry.run,
      );
      if (result.status !== 0) {
        return { result, runs };
      }
    }
    return {
      result: step(
        "next",
        'command -v bun\ncommand -v bunx\nbun --fixture\nbunx --fixture\nprintf "%s\\n" "$NODE_BIN"',
      ),
      runs,
    };
  }
  return {
    root,
    image,
    runnerTemp,
    nodeBin,
    cpu,
    npmLog,
    bunLog,
    log,
    archive,
    runAction,
    run() {
      prepareHelper();
      return spawnSync(process.execPath, [scriptPath], { encoding: "utf8", env });
    },
  };
}

describe("Bun image archive consumer", () => {
  it("creates independent private destinations and never reuses a modified extracted Bun", () => {
    const f = fixture();
    const bins: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      const bin = result.stdout.trim();
      bins.push(bin);
      expect(statSync(join(bin, "..")).mode & 0o777).toBe(0o700);
      expect(readdirSync(join(bin, ".."))).toEqual(["bin"]);
      expect(readFileSync(join(bin, "bunx"))).toEqual(readFileSync(join(bin, "bun")));
      writeFileSync(join(bin, "bun"), "modified extracted executable");
    }
    expect(bins[0]).not.toBe(bins[1]);
    expect(f.log(f.bunLog).split("\n")).toEqual(["linux-x64-baseline", "linux-x64-baseline"]);
    expect(readdirSync(f.runnerTemp)).toHaveLength(2);
  });

  it.each(["tampered", "directory", "symlink", "layout"] as const)(
    "fails setup on a present %s archive despite an old Bun, without npm fallback",
    (kind) => {
      const f = fixture();
      const baseline: Variant = "linux-x64-baseline";
      const archive = join(f.image, `bun-v1.4.2-${baseline}.zip`);
      if (kind === "layout") {
        f.archive(baseline, "1.4.2", "unexpected/bun");
      } else if (kind === "directory" || kind === "symlink") {
        rmSync(archive);
        if (kind === "directory") {
          mkdirSync(archive);
        } else {
          symlinkSync(join(f.image, "bun-v1.4.2-linux-x64.zip"), archive);
        }
      } else {
        writeFileSync(archive, "not an original Bun archive");
      }
      const { result, runs } = f.runAction();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Bun image cache:");
      expect(f.log(f.npmLog)).toBe("");
      expect(runs.has("Runtime versions")).toBe(false);
      expect(readdirSync(f.runnerTemp)).toEqual([]);
      expect(f.log(f.bunLog)).toBe("");
    },
  );

  it("uses the unchanged pinned npm fallback only when the matching archive is missing", () => {
    const f = fixture();
    rmSync(join(f.image, "bun-v1.4.2-linux-x64-baseline.zip"));
    const { result } = f.runAction();
    expect(result.status, result.stderr).toBe(0);
    expect(f.log(f.npmLog)).toBe("install -g bun@1.4.2");
    expect(result.stdout).toContain("npm-fallback-bun");
    expect(readdirSync(f.runnerTemp)).toEqual([]);
  });
});
