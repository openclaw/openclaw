import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTestRuntime } from "../../scripts/lib/test-runtime.mts";
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
const scratch = () => temp.make("isolated-");
const image = "a".repeat(64);
const file = "test/example.test.ts";
const config = "test/vitest/example.config.ts";
const name = "openclaw-vitest-fixture";
const label = "io.openclaw.vitest-isolated";
const selector = "--isolated-image";
function write(root: string, relative: string, content = "fixture") {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), content);
}
function sourceFixture() {
  const root = scratch();
  const snapshot = scratch();
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
const bindMount = (Source: string, Destination: string) => ({
  Type: "bind",
  Source,
  Destination,
  RW: true,
});
const environment = [
  "PATH=/opt/openclaw-vitest:/usr/local/bin:/usr/bin:/bin",
  "HOME=/tmp/home",
  "TMPDIR=/workspace/.openclaw/tmp",
  "LANG=C.UTF-8",
  "LC_ALL=C.UTF-8",
  "CI=1",
  "RAYON_NUM_THREADS=4",
  "TOKIO_WORKER_THREADS=4",
  "ROLLDOWN_WORKER_THREADS=4",
  "GOMAXPROCS=4",
  "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
  "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
  "COREPACK_ENABLE_NETWORK=0",
  "npm_config_manage_package_manager_versions=false",
  "container=podman",
];
const bunEnvironment = [
  "OPENCLAW_VITEST_RUNTIME=bun",
  "OPENCLAW_BUN_PATH=/opt/openclaw-vitest/bun",
];
function containerInspection(
  status = "exited",
  exit = 0,
  owner = name,
  runtime: "node" | "bun" = "node",
) {
  return {
    Config: {
      Labels: { [label]: owner },
      User: `${process.getuid?.()}:${process.getgid?.()}`,
      Env: [...environment, ...(runtime === "bun" ? bunEnvironment : [])],
    },
    HostConfig: { NetworkMode: "none", Privileged: false, ReadonlyRootfs: true, Init: true },
    Mounts: [
      bindMount("/owned/source", "/workspace"),
      ...(runtime === "bun"
        ? [{ ...bindMount("/owned/bun", "/opt/openclaw-vitest/bun"), RW: false }]
        : []),
    ],
    State: { Running: status === "running", Status: status, ExitCode: exit },
  };
}

describe("isolated Vitest admission", () => {
  it("executes the selected test runtime and its real child", () => {
    const runtime = process.versions.bun ? "bun" : "node";
    expect(runtime).toBe(resolveTestRuntime(process.env));
    const child = spawnSync(
      process.execPath,
      ["-e", "console.log(JSON.stringify({bun:process.versions.bun??null,exe:process.execPath}))"],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      },
    );
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      bun: process.versions.bun ?? null,
      exe: process.execPath,
    });
    if (process.env.container === "podman") {
      expect(process.execPath).toBe("/opt/openclaw-vitest/" + runtime);
      // sysfs also contains control files such as bonding_masters, not interfaces.
      const interfaces = fs
        .readdirSync("/sys/class/net", { withFileTypes: true })
        .filter((entry) => entry.isSymbolicLink())
        .map((entry) => entry.name);
      expect(interfaces).toEqual(["lo"]);
    }
  });
  it("dispatches the real wrapper before file checks, prerequisites or project delegation", async () => {
    const run = vi.spyOn(isolatedVitest, "runIsolatedVitest").mockResolvedValue(7);
    const previousExit = process.exitCode;
    const env = { PATH: "/prepared/tools" };
    try {
      await runVitest(vi.fn(), ["--isolated-image", image, "run", file], env);
      expect(run).toHaveBeenCalledWith(expect.any(String), image, ["run", file], env, "node");
      expect(process.exitCode).toBe(7);
    } finally {
      process.exitCode = previousExit;
      run.mockRestore();
    }
  });
  const testName = "literal shell ; $()";
  const originalArgs = ["run", file, "--config", config, "-t", testName, "--maxWorkers=1"];
  type ParseCase = [string[], ReturnType<typeof parseArgs> | string];
  const repoImage = `repo@sha256:${image}`;
  it.each([
    [[selector, image, ...originalArgs], { image, args: originalArgs, runtime: "node" }],
    [
      ["run", `${selector}=${repoImage}`, file],
      { image: repoImage, args: ["run", file], runtime: "node" },
    ],
    [originalArgs, null],
    [["run", "--", selector, image], null],
    [["run", "-t", `${selector}=${image}`], { image, args: ["run", "-t"], runtime: "node" }],
    ...["repo:tag", ""].map((value): ParseCase => [
      [selector, value, "run", file],
      "full local sha256",
    ]),
    [[selector, image, selector, image], "once"],
  ] satisfies ParseCase[])("parses only an unambiguous image selector: %j", (args, expected) => {
    if (typeof expected === "string") {
      expect(() => parseArgs(args)).toThrow(expected);
    } else {
      expect(parseArgs(args)).toEqual(expected);
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
      ["run", file, "--reporter", "./private-reporter.ts"],
      ["run", file, "--", "other.test.ts"],
    ]) {
      expect(() => admitArgs(args, tracked)).toThrow();
    }
  });
  it.each(["node", "bun"] as const)(
    "fixes isolation limits and exact %s bindings/environment",
    (runtime) => {
      const args = createArgs({
        ...createOptions(),
        bun: runtime === "bun" ? "/owned/bun" : undefined,
      });
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
          "--unsetenv-all",
        ]),
      );
      expect(args).toContain("--entrypoint=/opt/openclaw-vitest/node");
      expect(args.filter((arg) => arg.includes("dst=/opt/openclaw-vitest/bun,"))).toEqual(
        runtime === "bun" ? ["type=bind,src=/owned/bun,dst=/opt/openclaw-vitest/bun,ro"] : [],
      );
      expect(args.flatMap((arg, i) => (arg === "--env" ? [args[i + 1]] : []))).toEqual([
        ...environment,
        ...(runtime === "bun" ? bunEnvironment : []),
      ]);
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
    },
  );
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
  });
  it.each(["node", "bun"] as const)("refuses foreign environment and mounts for %s", (runtime) => {
    type Inspection = ReturnType<typeof containerInspection>;
    const mounts = [
      "/owned/source:/workspace:rw",
      ...(runtime === "bun" ? ["/owned/bun:/opt/openclaw-vitest/bun:ro"] : []),
    ];
    const inspected = () => containerInspection("exited", 0, name, runtime);
    const checked = (value: Inspection) => verifyContainer(value, name, mounts, runtime);
    expect(() => checked(inspected())).not.toThrow();
    const rejects = (mutate: (value: Inspection) => unknown, error = "isolation settings") => {
      const value = inspected();
      mutate(value);
      expect(() => checked(value)).toThrow(error);
    };
    rejects((value) => value.Config.Env.push("HTTP_PROXY=http://credential-proxy"), "environment");
    rejects((value) => value.Config.Env.push("OPENCLAW_BUN_PATH=/host/other-bun"), "environment");
    if (runtime === "bun") {
      expect(() => verifyContainer(inspected(), name, mounts)).toThrow("environment");
      rejects((value) => {
        value.Mounts[1]!.RW = true;
      }, "mounts");
    }
    rejects(({ HostConfig }) => Object.assign(HostConfig, { NetworkMode: "host" }));
    rejects(({ HostConfig }) => Object.assign(HostConfig, { Init: false }));
    rejects(
      (value) => value.Mounts.push(bindMount("/run/podman.sock", "/engine")),
      "unexpected host/default mounts",
    );
  });
});

describe("isolated working-tree source", () => {
  it.each(["fresh", "symlink"])("owns only fresh private scratch: %s", (kind) => {
    const snapshot = scratch();
    const outside = scratch();
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
    expect(source.copy(tracked, scratch()).digest).not.toBe(result.digest);
  });
  it("preserves tracked relative symlinks but refuses outside or untracked targets", () => {
    const source = sourceFixture();
    source.write("AGENTS.md");
    source.link("AGENTS.md", "CLAUDE.md");
    source.copy(["AGENTS.md", "CLAUDE.md"]);
    expect(source.readlink("CLAUDE.md")).toBe("AGENTS.md");
    expect(() => source.copy(["CLAUDE.md"], scratch())).toThrow("excluded/untracked");
    source.link("/etc/passwd", "outside.ts");
    expect(() => source.copy(["outside.ts"], scratch())).toThrow("escapes");
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
    const masked = prepare(scratch());
    const dotenv = masked.find((mount) => mount.target.endsWith("/.env"));
    expect(dotenv).toBeDefined();
    expect(fs.readFileSync(dotenv!.source, "utf8")).toBe("");
    source.link("/etc/passwd", "node_modules/.pnpm/escape");
    expect(() => prepare(scratch())).toThrow("escapes");
  });
});

function lifecycle(
  options: {
    exit?: number;
    failure?: "create" | "verify" | "start" | "remove" | "ownership";
    unjoined?: Error;
  } = {},
) {
  const calls: string[][] = [];
  const { failure, exit = 0 } = options;
  let present = false;
  let state = "created";
  const result = (code = 0, stdout = "") => ({ code, stdout });
  const command: IsolatedPodmanCommand = async (args) => {
    calls.push(args);
    switch (args[0] === "container" ? `container ${args[1]}` : args[0]) {
      case "container exists":
        return result(present ? 0 : 1);
      case "create":
        if (options.unjoined) {
          throw options.unjoined;
        }
        present = true;
        return result(failure === "create" || failure === "ownership" ? 125 : 0, "id");
      case "container inspect": {
        const owner = failure === "ownership" ? "another-invocation" : name;
        return result(0, JSON.stringify([containerInspection(state, exit, owner)]));
      }
      case "start":
        state = failure === "start" ? "running" : "exited";
        if (failure === "start") {
          throw new Error("attach interrupted");
        }
        return result(exit);
      case "stop":
        state = "exited";
        break;
      case "wait":
        return result(0, String(exit));
      case "rm":
        if (failure === "remove") {
          return result(125);
        }
        present = false;
        break;
      default:
        throw new Error(`Unexpected fixture command: ${args.join(" ")}`);
    }
    return result();
  };
  const onAbsent = vi.fn();
  const run = () =>
    runContainer({
      command,
      name,
      createArgs: ["create"],
      onAbsent,
      verify: () => {
        if (failure === "verify") {
          throw new Error("unexpected mounts");
        }
      },
    });
  return { calls, onAbsent, run };
}

describe("isolated container lifecycle", () => {
  it("preserves a failing test exit only after wait, remove and confirmed absence", async () => {
    const fixture = lifecycle({ exit: 7 });
    expect(await fixture.run()).toBe(7);
    expect(fixture.onAbsent).toHaveBeenCalledOnce();
    expect(fixture.calls).toContainEqual(["wait", name]);
    expect(fixture.calls.at(-2)).toEqual(["rm", "--force", "--time", "5", name]);
    expect(fixture.calls.at(-1)).toEqual(["container", "exists", name]);
  });
  it("retains inputs after an unjoined Podman process despite container absence", async () => {
    const failure = new AggregateError(
      [
        Object.assign(new Error("process cleanup unresolved"), {
          processTreeState: "indeterminate",
        }),
      ],
      "Podman create failed",
    );
    const fixture = lifecycle({ unjoined: failure });
    await expect(fixture.run()).rejects.toBe(failure);
    expect(fixture.calls.at(-1)).toEqual(["container", "exists", name]);
    expect(fixture.onAbsent).not.toHaveBeenCalled();
  });
  it.each([
    ["create", "create failed", true],
    ["verify", "unexpected mounts", true],
    ["start", "attach interrupted", true],
    ["remove", "cleanup failed", false],
    ["ownership", "cleanup failed", false],
  ] as const)("reconciles %s failure", async (failure, error, absent) => {
    const fixture = lifecycle({ failure });
    const result = fixture.run();
    if (failure === "ownership") {
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
      if (failure === "start") {
        expect(fixture.calls).toContainEqual(["stop", "--time", "5", name]);
        expect(fixture.calls).toContainEqual(["wait", name]);
      } else if (failure !== "remove") {
        expect(fixture.calls.some((args) => args[0] === "start")).toBe(false);
      }
    }
    expect(fixture.onAbsent).toHaveBeenCalledTimes(absent ? 1 : 0);
  });
});
