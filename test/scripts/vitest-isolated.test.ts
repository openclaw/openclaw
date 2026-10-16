import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyIsolatedVitestSource as copySource,
  prepareIsolatedVitestDependencies as prepareDependencies,
  prepareIsolatedVitestScratch as prepareScratch,
} from "../../scripts/lib/vitest-isolated-source.mts";
import * as isolatedVitest from "../../scripts/lib/vitest-isolated.mts";
import {
  admitIsolatedVitestArgs as admitArgs,
  isolatedVitestCreateArgs as createArgs,
  parseIsolatedVitestArgs as parseArgs,
  runIsolatedVitestContainer as runContainer,
  verifyIsolatedVitestContainer as verifyContainer,
  verifyIsolatedVitestHost as verifyHost,
  type IsolatedPodmanCommand,
} from "../../scripts/lib/vitest-isolated.mts";
import { runVitest } from "../../scripts/run-vitest.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const image = "a".repeat(64);
const file = "test/example.test.ts";
const config = "test/vitest/example.config.ts";
const name = "openclaw-vitest-fixture";
const label = "io.openclaw.vitest-isolated";
function write(root: string, relative: string, content = "fixture") {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), content);
}
function sourceFixture() {
  const root = temp.make("isolated-source-");
  const snapshot = temp.make("isolated-copy-");
  return {
    root,
    snapshot,
    write: (relative: string, content?: string) => write(root, relative, content),
    read: (relative: string) => fs.readFileSync(path.join(snapshot, relative), "utf8"),
    exists: (relative: string) => fs.existsSync(path.join(snapshot, relative)),
    link: (target: string, relative: string) => fs.symlinkSync(target, path.join(root, relative)),
    readlink: (relative: string) => fs.readlinkSync(path.join(snapshot, relative)),
    copy: (tracked: string[], target = snapshot) => copySource(root, target, tracked),
  };
}
function createOptions() {
  return {
    name,
    image,
    snapshot: "/owned/source",
    mounts: [{ source: "/repo/node_modules/.pnpm", target: "/workspace/node_modules/.pnpm" }],
    node: "/toolchain/node",
    pnpm: "/toolchain/pnpm",
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    pnpmVersion: "12.4.0",
    argv: ["run", file],
  };
}
function containerInspection() {
  const create = createArgs(createOptions());
  return {
    Config: {
      Labels: { [label]: name },
      User: `${process.getuid?.()}:${process.getgid?.()}`,
      Env: create.flatMap((arg, index) => (arg === "--env" ? [create[index + 1]!] : [])),
    },
    HostConfig: { NetworkMode: "none", Privileged: false, ReadonlyRootfs: true, Init: true },
    Mounts: [{ Type: "bind", Source: "/owned/source", Destination: "/workspace", RW: true }],
    State: { Running: false, Status: "exited", ExitCode: 0 },
  };
}

describe("isolated Vitest admission", () => {
  it("dispatches the real wrapper before file checks, prerequisites or project delegation", async () => {
    const run = vi.spyOn(isolatedVitest, "runIsolatedVitest").mockResolvedValue(7);
    const previousExit = process.exitCode;
    const env = { PATH: "/prepared/tools" };
    try {
      await runVitest(vi.fn(), ["--isolated-image", image, "run", file], env);
      expect(run).toHaveBeenCalledWith(expect.any(String), image, ["run", file], env);
      expect(process.exitCode).toBe(7);
    } finally {
      process.exitCode = previousExit;
      run.mockRestore();
    }
  });
  const originalArgs = [
    "run",
    file,
    "--config",
    config,
    "-t",
    "literal shell ; $()",
    "--maxWorkers=1",
  ];
  it.each([
    { args: ["--isolated-image", image, ...originalArgs], expected: { image, args: originalArgs } },
    {
      args: ["run", `--isolated-image=repo@sha256:${image}`, file],
      expected: { image: `repo@sha256:${image}`, args: ["run", file] },
    },
    { args: originalArgs, expected: null },
    { args: ["run", "--", "--isolated-image", image], expected: null },
    { args: ["run", "-t", `--isolated-image=${image}`], expected: { image, args: ["run", "-t"] } },
    ...["repo:tag", "sha256:1234", ""].map((value) => ({
      args: ["--isolated-image", value, "run", file],
      error: "full local sha256",
    })),
    { args: ["--isolated-image", image, "--isolated-image", image], error: "once" },
  ])("parses only an unambiguous image selector: $args", (scenario) => {
    if ("error" in scenario) {
      expect(() => parseArgs(scenario.args)).toThrow(scenario.error);
    } else {
      expect(parseArgs(scenario.args)).toEqual(scenario.expected);
    }
  });
  it("admits tracked exact files and config but not old/untracked or alternate inputs", () => {
    const tracked = new Set([file, config]);
    expect(() =>
      admitArgs(["run", "--config", config, "--configLoader", "runner", file], tracked),
    ).not.toThrow();
    for (const args of [
      ["run"],
      ["watch", file],
      ["run", "test/untracked.test.ts"],
      ["run", "test/*.test.ts"],
      ["run", "/host/test/example.test.ts"],
      ["run", file, "--config", "private.config.ts"],
      ["run", file, "--configLoader", "native"],
      ["run", file, "--root", "/host"],
      ["run", file, "--outputFile", "/host/report"],
      ["run", file, "--reporter", "./private-reporter.ts"],
      ["run", file, "--", "other.test.ts"],
    ]) {
      expect(() => admitArgs(args, tracked)).toThrow();
    }
  });
  it("fixes isolation limits, image entrypoint and an explicit benign environment", () => {
    const args = createArgs(createOptions());
    expect(args).toEqual(
      expect.arrayContaining([
        "--pull=never",
        "--network=none",
        "--http-proxy=false",
        "--cap-drop=all",
        "--security-opt=no-new-privileges",
        "--read-only",
        "--userns=keep-id",
        "--init",
        "--cpus=4",
        "--memory=8g",
        "--pids-limit=512",
        "--shm-size=512m",
        "/tmp:rw,nosuid,nodev,size=2g,mode=1777",
        "TMPDIR=/workspace/.openclaw/tmp",
        "HOME=/tmp/home",
        "--unsetenv-all",
        "RAYON_NUM_THREADS=4",
        "TOKIO_WORKER_THREADS=4",
        "ROLLDOWN_WORKER_THREADS=4",
        "GOMAXPROCS=4",
      ]),
    );
    expect(args).not.toContain("--env-host");
    expect(args.join(" ")).not.toMatch(
      /docker.sock|podman.sock|network=host|HTTP_PROXY|AWS_|OPENAI_/u,
    );
    expect(args).toContain(
      "type=bind,src=/repo/node_modules/.pnpm,dst=/workspace/node_modules/.pnpm,ro",
    );
    expect(args.slice(-2)).toEqual(["run", file]);
    expect(() => createArgs({ ...createOptions(), snapshot: "/owned,escape" })).toThrow(
      "bind path",
    );
  });
  it.each([
    ["test/vitest/vitest.unit-fast.config.ts", "src/plugins/source-checkout-runtime.test.ts"],
    [
      "test/vitest/vitest.ui-e2e.config.ts",
      "ui/src/e2e/command-palette-catalog.real-gateway.e2e.test.ts",
    ],
  ])("reserves bounded build capacity for %s", (selectedConfig, selectedFile) => {
    const args = createArgs({
      ...createOptions(),
      argv: ["run", "--config", selectedConfig, selectedFile],
    });
    expect(args).toEqual(expect.arrayContaining(["--memory=16g", "--memory-swap=16g"]));
    expect(args).not.toContain("--memory=8g");
  });

  it("admits only supported host isolation without relabeling shared host files", () => {
    expect(() => verifyHost({ rootless: true, selinuxEnabled: false })).not.toThrow();
    expect(() => verifyHost({ rootless: false, selinuxEnabled: false })).toThrow("rootless");
    expect(() => verifyHost({ rootless: true, selinuxEnabled: true })).toThrow("will not relabel");
    expect(() => verifyHost({ rootless: true })).toThrow("SELinux");
  });
  it("refuses inherited image environment, host networking and unexpected engine mounts", () => {
    const verify =
      (value = containerInspection()) =>
      () =>
        verifyContainer(value, name, ["/owned/source:/workspace:rw"]);
    expect(verify()).not.toThrow();
    const poisoned = containerInspection();
    poisoned.Config.Env.push("HTTP_PROXY=http://credential-proxy");
    expect(verify(poisoned)).toThrow("environment");
    const network = containerInspection();
    network.HostConfig.NetworkMode = "host";
    expect(verify(network)).toThrow("isolation settings");
    const noInit = containerInspection();
    noInit.HostConfig.Init = false;
    expect(verify(noInit)).toThrow("isolation settings");
    const mount = containerInspection();
    mount.Mounts.push({
      Type: "bind",
      Source: "/run/podman.sock",
      Destination: "/engine",
      RW: true,
    });
    expect(verify(mount)).toThrow("unexpected host/default mounts");
  });
});

describe("isolated working-tree source", () => {
  it.each(["fresh", "symlink"])("owns only fresh private scratch: %s", (kind) => {
    const snapshot = temp.make("isolated-scratch-");
    const outside = temp.make("isolated-scratch-outside-");
    if (kind === "symlink") {
      fs.symlinkSync(outside, path.join(snapshot, ".openclaw"), "dir");
    } else {
      prepareScratch(snapshot);
      for (const relative of [".openclaw", ".openclaw/tmp"]) {
        const directory = path.join(snapshot, relative);
        expect(fs.realpathSync(directory)).toBe(directory);
        if (process.platform !== "win32") {
          expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
        }
      }
    }
    expect(() => prepareScratch(snapshot)).toThrow(/EEXIST/u);
    if (kind === "symlink") {
      expect(fs.readdirSync(outside)).toEqual([]);
    }
  });
  it("copies current staged-path bytes, preserves deletions, excludes private state and does not copy untracked files", () => {
    const source = sourceFixture();
    const tracked = [file, "new.test.ts", "deleted.test.ts"];
    const privateFiles = [".git/config", ".openclaw/private", ".env", "dist/old.js"];
    for (const item of [file, "new.test.ts", "untracked.test.ts", ...privateFiles]) {
      source.write(item, item === file ? "working tree, not HEAD" : "private");
    }
    const result = source.copy([...tracked, ...privateFiles]);
    expect(source.read(file)).toBe("working tree, not HEAD");
    expect(result.copied).toEqual(new Set([file, "new.test.ts"]));
    expect(source.exists("untracked.test.ts")).toBe(false);
    source.write(file, "changed working bytes");
    expect(source.copy(tracked, temp.make("isolated-second-")).digest).not.toBe(result.digest);
  });
  it("preserves tracked relative symlinks but refuses outside or untracked targets", () => {
    const source = sourceFixture();
    source.write("AGENTS.md");
    source.link("AGENTS.md", "CLAUDE.md");
    source.copy(["AGENTS.md", "CLAUDE.md"]);
    expect(source.readlink("CLAUDE.md")).toBe("AGENTS.md");
    expect(() => source.copy(["CLAUDE.md"], temp.make("isolated-untracked-link-"))).toThrow(
      "excluded/untracked",
    );
    source.link("/etc/passwd", "outside.ts");
    expect(() => source.copy(["outside.ts"], temp.make("isolated-outside-link-"))).toThrow(
      "escapes",
    );
  });
  it("projects readonly package trees and relocatable workspace symlinks without cached outputs", () => {
    const source = sourceFixture();
    const dependency = "node_modules/.pnpm/example/node_modules/dependency";
    source.write("packages/example/package.json", "{}");
    source.write(`${dependency}/package.json`, "{}");
    source.write(
      "node_modules/.bin/tool",
      `#!/bin/sh
NODE_PATH='${source.root}/node_modules'
`,
    );
    source.write("node_modules/.vite/stale", "old output");
    source.link("../packages/example", "node_modules/example");
    const copied = source.copy(["packages/example/package.json"]).copied;
    const prepare = (snapshot = source.snapshot) =>
      prepareDependencies(source.root, snapshot, copied);
    const mounts = prepare();
    expect(mounts).toEqual([
      {
        source: path.join(source.root, "node_modules/.pnpm"),
        target: "/workspace/node_modules/.pnpm",
      },
    ]);
    expect(source.readlink("node_modules/example")).toBe("../packages/example");
    expect(source.read("node_modules/.bin/tool")).toContain("/workspace/node_modules");
    expect(source.exists("node_modules/.vite/stale")).toBe(false);
    source.write(`${dependency}/.env`, "synthetic-secret");
    const masked = prepare(temp.make("isolated-masked-deps-"));
    const dotenv = masked.find((mount) => mount.target.endsWith("/.env"));
    expect(dotenv).toBeDefined();
    expect(fs.readFileSync(dotenv!.source, "utf8")).toBe("");
    source.link("/etc/passwd", "node_modules/.pnpm/escape");
    expect(() => prepare(temp.make("isolated-bad-deps-"))).toThrow("escapes");
  });
});

function lifecycle(
  options: {
    exit?: number;
    failCreate?: boolean;
    failStart?: boolean;
    failRemove?: boolean;
    label?: string;
    failVerify?: boolean;
    unjoined?: Error;
  } = {},
) {
  const calls: string[][] = [];
  let present = false;
  let running = false;
  let started = false;
  const command: IsolatedPodmanCommand = async (args) => {
    calls.push(args);
    if (args[0] === "container" && args[1] === "exists") {
      return { code: present ? 0 : 1, stdout: "" };
    }
    if (args[0] === "create") {
      if (options.unjoined) {
        throw options.unjoined;
      }
      present = true;
      return { code: options.failCreate ? 125 : 0, stdout: "id" };
    }
    if (args[0] === "container" && args[1] === "inspect") {
      const inspected = containerInspection();
      inspected.Config.Labels[label] = options.label ?? name;
      inspected.State = {
        Running: running,
        Status: running ? "running" : started ? "exited" : "created",
        ExitCode: options.exit ?? 0,
      };
      return { code: 0, stdout: JSON.stringify([inspected]) };
    }
    if (args[0] === "start") {
      started = true;
      running = options.failStart === true;
      if (options.failStart) {
        throw new Error("attach interrupted");
      }
      return { code: options.exit ?? 0, stdout: "" };
    }
    if (args[0] === "stop") {
      running = false;
    }
    if (args[0] === "wait") {
      return { code: 0, stdout: String(options.exit ?? 0) };
    }
    if (args[0] === "rm") {
      if (options.failRemove) {
        return { code: 125, stdout: "" };
      }
      present = false;
    }
    return { code: 0, stdout: "" };
  };
  const onAbsent = vi.fn();
  const run = () =>
    runContainer({
      command,
      name,
      createArgs: ["create"],
      onAbsent,
      verify: () => {
        if (options.failVerify) {
          throw new Error("unexpected mounts");
        }
      },
    });
  return { calls, onAbsent, run };
}

describe("isolated container lifecycle", () => {
  it.each([0, 7])(
    "preserves test exit %s only after wait, remove and confirmed absence",
    async (exit) => {
      const fixture = lifecycle({ exit });
      expect(await fixture.run()).toBe(exit);
      expect(fixture.onAbsent).toHaveBeenCalledOnce();
      expect(fixture.calls).toContainEqual(["wait", name]);
      expect(fixture.calls.at(-2)).toEqual(["rm", "--force", "--time", "5", name]);
      expect(fixture.calls.at(-1)).toEqual(["container", "exists", name]);
    },
  );
  it.each(["live", "indeterminate"])(
    "retains inputs after an unjoined %s Podman process despite container absence",
    async (processTreeState) => {
      const failure = new AggregateError(
        [Object.assign(new Error("process cleanup unresolved"), { processTreeState })],
        "Podman create failed",
      );
      const fixture = lifecycle({ unjoined: failure });
      await expect(fixture.run()).rejects.toBe(failure);
      expect(fixture.calls.at(-1)).toEqual(["container", "exists", name]);
      expect(fixture.onAbsent).not.toHaveBeenCalled();
    },
  );
  it.each([
    { options: { failCreate: true }, error: "create failed", absent: true },
    { options: { failVerify: true }, error: "unexpected mounts", absent: true },
    { options: { failStart: true }, error: "attach interrupted", absent: true },
    { options: { failRemove: true }, error: "cleanup failed", absent: false },
    {
      options: { failCreate: true, label: "another-invocation" },
      error: "cleanup failed",
      absent: false,
    },
  ])("reconciles $options with $error", async ({ options, error, absent }) => {
    const fixture = lifecycle(options);
    const result = fixture.run();
    if ("label" in options) {
      await expect(result).rejects.toMatchObject({
        message: expect.stringContaining("cleanup failed"),
        errors: [
          expect.any(Error),
          expect.objectContaining({ message: expect.stringContaining("ownership") }),
        ],
      });
      expect(fixture.calls.some((args) => args[0] === "rm")).toBe(false);
    } else {
      await expect(result).rejects.toThrow(error);
      if ("failStart" in options) {
        expect(fixture.calls).toContainEqual(["stop", "--time", "5", name]);
        expect(fixture.calls).toContainEqual(["wait", name]);
      } else if (!("failRemove" in options)) {
        expect(fixture.calls.some((args) => args[0] === "start")).toBe(false);
      }
    }
    if (absent) {
      expect(fixture.onAbsent).toHaveBeenCalledOnce();
    } else {
      expect(fixture.onAbsent).not.toHaveBeenCalled();
    }
  });
});
