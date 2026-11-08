import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

function packFixture(
  mode: "success" | "failure" | "symlink" | "prepare" | "size-limit" | "oversized" = "success",
  containerName?: string,
) {
  const root = directories.make("clawhub-container-");
  const source = join(root, mode === "prepare" ? "candidate" : "candidate source");
  const tooling = join(root, mode === "prepare" ? "tooling" : "trusted tooling");
  const output = join(root, "output");
  const callsPath = join(root, "docker-calls.jsonl");
  for (const dir of [source, tooling, output]) {
    mkdirSync(dir);
  }
  mkdirSync(join(tooling, "scripts"));
  mkdirSync(join(tooling, "node_modules"));
  writeFileSync(join(source, "source-marker"), "candidate");
  writeFileSync(
    join(tooling, "scripts/plugin-clawhub-publish.sh"),
    [
      "set -eu",
      "test -f source-marker",
      "test -L node_modules",
      'test "$1" = --pack',
      'test "$2" = extensions/example',
      'test "$3" = --metadata-root',
      'test "$4" = "' + tooling + '"',
      'test "$OPENCLAW_CLAWHUB_CLI" = "' + tooling + '/.clawhub-cli/node_modules/.bin/clawhub"',
      'if env | grep -E "^(GITHUB_TOKEN|GITHUB_ENV|DOCKER_HOST)="; then exit 1; fi',
      'printf "%s" "$PWD" > "$OPENCLAW_CLAWHUB_PACK_OUTPUT_DIR/package.tgz"',
    ].join("\n"),
  );
  const docker = join(root, "docker");
  writeFileSync(
    docker,
    [
      "#!" + process.execPath,
      'import fs from "node:fs";',
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(" +
        JSON.stringify(callsPath) +
        ", JSON.stringify({args, env: process.env}) + '\\n');",
      "if (args.includes('run')) {",
      ...(mode === "prepare"
        ? [
            "  const { execFileSync } = await import('node:child_process');",
            "  let script = args[args.indexOf('-euc') + 1];",
            "  for (const [from, to] of " +
              JSON.stringify([
                ["/source-input", source],
                ["/tooling", tooling],
                ["/output", output],
                ["/work", join(root, "work")],
                ["/tmp/home", join(root, "home")],
              ]) +
              ") script = script.replaceAll(from, to);",
            "  const env = Object.fromEntries(args.flatMap((arg, i) => args[i - 1] === '--env' ? [[arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]] : []));",
            "  execFileSync('/bin/bash', ['-euc', script, 'fixture', args.at(-1)], {env});",
            "  process.exit(0);",
          ]
        : []),
      "  const mount = args.find(arg => arg.endsWith(',dst=/output'));",
      "  const output = mount.slice('type=bind,src='.length, -',dst=/output'.length);",
      mode === "symlink"
        ? "  fs.symlinkSync('/etc/passwd', output + '/package.tgz');"
        : "  fs.writeFileSync(output + '/package.tgz', 'fixture');",
      ...(mode === "size-limit" || mode === "oversized"
        ? [
            "  fs.truncateSync(output + '/package.tgz', " +
              (1024 ** 3 + (mode === "oversized" ? 1 : 0)) +
              ");",
          ]
        : []),
      "  console.log('::error::untrusted workflow command\\r::warning::more');",
      "  process.exit(" + (mode === "failure" ? "17" : "0") + ");",
      "}",
    ].join("\n"),
  );
  chmodSync(docker, 0o755);
  const result = spawnSync(
    process.execPath,
    ["scripts/plugin-clawhub-pack-isolated.mjs", source, tooling, output, "extensions/example"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: root,
        HOME: join(root, "private-home"),
        GITHUB_TOKEN: "must-not-cross-boundary",
        GITHUB_ENV: join(root, "runner-command-file"),
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "must-not-cross-boundary",
        NODE_OPTIONS: "",
        DOCKER_HOST: "tcp://untrusted-daemon",
        SOURCE_REPO: "openclaw/openclaw",
        SOURCE_COMMIT: "a".repeat(40),
        SOURCE_REF: "refs/tags/v2026.11.5",
        PACKAGE_TAG: "latest",
        PACK_CONTAINER_NAME: containerName,
      },
    },
  );
  const calls = (existsSync(callsPath) ? readFileSync(callsPath, "utf8") : "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> });
  return { ...result, calls, source, tooling, output };
}

describe.skipIf(process.platform !== "linux")("isolated ClawHub pack process boundary", () => {
  it("passes only bridged networking, read-only inputs and explicit metadata to Docker", () => {
    const result = packFixture();
    expect(result.status, result.stderr).toBe(0);
    const run = result.calls[0]!;
    expect(run.args).toEqual(
      expect.arrayContaining([
        "--network=bridge",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pull=never",
        "--ulimit",
        "fsize=1073741824:1073741824",
      ]),
    );
    for (const forbidden of [
      "--network=host",
      "--privileged",
      "--env-file",
      "--volumes-from",
      "--use-api-socket",
    ]) {
      expect(run.args).not.toContain(forbidden);
    }
    const mounts = run.args.filter((_, index) => run.args[index - 1] === "--mount");
    expect(mounts.filter((mount) => !mount.endsWith(",readonly"))).toEqual([
      "type=bind,src=" + result.output + ",dst=/output",
    ]);
    expect(mounts).toContain("type=bind,src=" + result.source + ",dst=/source-input,readonly");
    expect(mounts.some((mount) => mount.includes("/.git,") || mount.includes("/.npmrc,"))).toBe(
      false,
    );
    const env = run.args.filter((_, index) => run.args[index - 1] === "--env");
    expect(env).toEqual([
      "SOURCE_REPO=openclaw/openclaw",
      "SOURCE_COMMIT=" + "a".repeat(40),
      "SOURCE_REF=refs/tags/v2026.11.5",
      "PACKAGE_TAG=latest",
    ]);
    expect(Object.keys(run.env)).toEqual(["PATH"]);
    expect(run.args.join(" ")).not.toContain("must-not-cross-boundary");
    expect(run.args).toContain(
      "docker.io/library/node:24.22.1-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a",
    );
    expect(result.calls[1]!.args.slice(2, 4)).toEqual(["rm", "--force"]);
    expect(result.calls[1]!.args[4]).toBe(run.args[run.args.indexOf("--name") + 1]);
    expect(result.calls[1]!.args[4]).toMatch(
      /^clawhub-pack-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
    );
    expect(existsSync(run.args[1]!)).toBe(false);
    expect(result.stdout).toContain('[isolated pack] "::error::untrusted workflow command');
    expect(result.stdout.split("\n").some((line) => line.startsWith("::"))).toBe(false);
    expect(result.stdout).not.toContain("\r");
  });

  it("prepares writable source and invokes the absolute CLI contract from the source cwd", () => {
    const result = packFixture("prepare");
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(result.output, "package.tgz"), "utf8")).toBe(
      join(result.source, "..", "work", "source"),
    );
    expect(readFileSync(join(result.source, "source-marker"), "utf8")).toBe("candidate");
    expect(existsSync(join(result.source, "node_modules"))).toBe(false);
  });

  it("propagates build failure and still removes the named container", () => {
    const result = packFixture("failure", "clawhub-pack-12345-2-0");
    expect(result.status).toBe(17);
    expect(result.calls).toHaveLength(2);
    expect(result.calls[1]!.args.slice(2, 4)).toEqual(["rm", "--force"]);
    expect(result.calls[0]!.args[result.calls[0]!.args.indexOf("--name") + 1]).toBe(
      "clawhub-pack-12345-2-0",
    );
    expect(result.calls[1]!.args[4]).toBe("clawhub-pack-12345-2-0");
  });

  it.each([
    "",
    "other-container",
    "clawhub-pack-../other",
    "clawhub-pack-name\n",
    "clawhub-pack-" + "a".repeat(102),
  ])("rejects invalid container name %j before invoking Docker", (name) => {
    const result = packFixture("success", name);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("PACK_CONTAINER_NAME must be");
    expect(result.calls).toEqual([]);
  });

  it("accepts a regular artifact at the 1 GiB limit", () => {
    const result = packFixture("size-limit");
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects artifacts larger than 1 GiB before upload", () => {
    const result = packFixture("oversized");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("artifacts must total at most 1 GiB");
    expect(result.calls).toHaveLength(2);
  });

  it("rejects output symlinks before the artifact uploader can follow them", () => {
    const result = packFixture("symlink");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("exactly one regular .tgz file");
  });

  it.each([
    { failure: "", expectedStatus: 0 },
    {
      failure: "Error response from daemon: No such container: clawhub-pack-12345-2-0",
      expectedStatus: 0,
    },
    { failure: "Cannot connect to the Docker daemon", expectedStatus: 1 },
  ])(
    "runs workflow cancellation cleanup independently of the helper: $failure",
    ({ failure, expectedStatus }) => {
      const root = directories.make("clawhub-cleanup-");
      const argsPath = join(root, "args.json");
      const docker = join(root, "docker");
      writeFileSync(
        docker,
        [
          "#!" + process.execPath,
          'import fs from "node:fs";',
          "fs.writeFileSync(" +
            JSON.stringify(argsPath) +
            ", JSON.stringify(process.argv.slice(2)));",
          "console.error(" + JSON.stringify(failure) + ");",
          "process.exit(" + (failure ? 1 : 0) + ");",
        ].join("\n"),
      );
      chmodSync(docker, 0o755);
      const workflow = parse(readFileSync(".github/workflows/plugin-clawhub-release.yml", "utf8"));
      const cleanup = workflow.jobs.pack_plugins_clawhub_artifacts.steps.find(
        (step: { name: string }) => step.name === "Remove isolated pack container",
      );
      const result = spawnSync("/bin/bash", ["-c", cleanup.run], {
        encoding: "utf8",
        env: { PATH: root + ":/usr/bin:/bin", PACK_CONTAINER_NAME: "clawhub-pack-12345-2-0" },
      });
      expect(result.status, result.stderr).toBe(expectedStatus);
      const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
      expect(args.slice(2)).toEqual(["rm", "--force", "clawhub-pack-12345-2-0"]);
      expect(existsSync(args[1]!)).toBe(false);
    },
  );
});
