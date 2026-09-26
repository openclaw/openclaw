import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyIsolatedVitestSource,
  prepareIsolatedVitestDependencies,
} from "../../scripts/lib/vitest-isolated-source.mts";
import * as isolatedVitest from "../../scripts/lib/vitest-isolated.mts";
import {
  admitIsolatedVitestArgs,
  isolatedVitestCreateArgs,
  parseIsolatedVitestArgs,
  runIsolatedVitestContainer,
  verifyIsolatedVitestContainer,
  verifyIsolatedVitestHost,
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
  const create = isolatedVitestCreateArgs(createOptions());
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
  it("consumes only the opt-in and preserves argv tokens exactly", () => {
    const args = ["run", file, "--config", config, "-t", "literal shell ; $()", "--maxWorkers=1"];
    expect(parseIsolatedVitestArgs(["--isolated-image", image, ...args])).toEqual({ image, args });
    expect(parseIsolatedVitestArgs(["run", `--isolated-image=repo@sha256:${image}`, file])).toEqual(
      { image: `repo@sha256:${image}`, args: ["run", file] },
    );
    expect(parseIsolatedVitestArgs(args)).toBeNull();
    expect(parseIsolatedVitestArgs(["run", "--", "--isolated-image", image])).toBeNull();
    expect(parseIsolatedVitestArgs(["run", "-t", `--isolated-image=${image}`])).toEqual({
      image,
      args: ["run", "-t"],
    });
  });
  it.each(["latest", "repo:tag", "sha256:1234", "", "--network=host"])(
    "refuses ambiguous image %s",
    (value) => {
      expect(() => parseIsolatedVitestArgs(["--isolated-image", value, "run", file])).toThrow(
        "full local sha256",
      );
    },
  );
  it("refuses duplicate image selectors", () => {
    expect(() =>
      parseIsolatedVitestArgs(["--isolated-image", image, "--isolated-image", image]),
    ).toThrow("once");
  });
  it("admits tracked exact files and config but not old/untracked or alternate inputs", () => {
    const tracked = new Set([file, config]);
    expect(() =>
      admitIsolatedVitestArgs(
        ["run", "--config", config, "--configLoader", "runner", file],
        tracked,
      ),
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
      expect(() => admitIsolatedVitestArgs(args, tracked)).toThrow();
    }
  });
  it("fixes isolation limits, image entrypoint and an explicit benign environment", () => {
    const args = isolatedVitestCreateArgs(createOptions());
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
    expect(() =>
      isolatedVitestCreateArgs({ ...createOptions(), snapshot: "/owned,escape" }),
    ).toThrow("bind path");
  });
  it("admits only supported host isolation without relabeling shared host files", () => {
    expect(() => verifyIsolatedVitestHost({ rootless: true, selinuxEnabled: false })).not.toThrow();
    expect(() => verifyIsolatedVitestHost({ rootless: false, selinuxEnabled: false })).toThrow(
      "rootless",
    );
    expect(() => verifyIsolatedVitestHost({ rootless: true, selinuxEnabled: true })).toThrow(
      "will not relabel",
    );
    expect(() => verifyIsolatedVitestHost({ rootless: true })).toThrow("SELinux");
  });
  it("refuses inherited image environment, host networking and unexpected engine mounts", () => {
    const expected = ["/owned/source:/workspace:rw"];
    expect(() =>
      verifyIsolatedVitestContainer(containerInspection(), name, expected),
    ).not.toThrow();
    const unreaped = containerInspection();
    unreaped.HostConfig.Init = false;
    expect(() => verifyIsolatedVitestContainer(unreaped, name, expected)).toThrow(
      "isolation settings",
    );
    const poisoned = containerInspection();
    poisoned.Config.Env.push("HTTP_PROXY=http://credential-proxy");
    expect(() => verifyIsolatedVitestContainer(poisoned, name, expected)).toThrow("environment");
    const network = containerInspection();
    network.HostConfig.NetworkMode = "host";
    expect(() => verifyIsolatedVitestContainer(network, name, expected)).toThrow(
      "isolation settings",
    );
    const mount = containerInspection();
    mount.Mounts.push({
      Type: "bind",
      Source: "/run/podman.sock",
      Destination: "/engine",
      RW: true,
    });
    expect(() => verifyIsolatedVitestContainer(mount, name, expected)).toThrow(
      "unexpected host/default mounts",
    );
  });
});

describe("isolated working-tree source", () => {
  it("copies current staged-path bytes, preserves deletions, excludes private state and does not copy untracked files", () => {
    const root = temp.make("isolated-source-");
    const snapshot = temp.make("isolated-copy-");
    for (const item of [
      file,
      "new.test.ts",
      "untracked.test.ts",
      ".git/config",
      ".openclaw/private",
      ".env",
      "dist/old.js",
    ]) {
      write(root, item, item === file ? "working tree, not HEAD" : "private");
    }
    const result = copyIsolatedVitestSource(root, snapshot, [
      file,
      "new.test.ts",
      "deleted.test.ts",
      ".git/config",
      ".openclaw/private",
      ".env",
      "dist/old.js",
    ]);
    expect(fs.readFileSync(path.join(snapshot, file), "utf8")).toBe("working tree, not HEAD");
    expect(result.copied).toEqual(new Set([file, "new.test.ts"]));
    expect(fs.existsSync(path.join(snapshot, "untracked.test.ts"))).toBe(false);
    write(root, file, "changed working bytes");
    expect(
      copyIsolatedVitestSource(root, temp.make("isolated-second-"), [
        file,
        "new.test.ts",
        "deleted.test.ts",
      ]).digest,
    ).not.toBe(result.digest);
  });
  it("preserves tracked relative symlinks but refuses outside or untracked targets", () => {
    const root = temp.make("isolated-links-");
    write(root, "AGENTS.md");
    fs.symlinkSync("AGENTS.md", path.join(root, "CLAUDE.md"));
    const snapshot = temp.make("isolated-good-link-");
    copyIsolatedVitestSource(root, snapshot, ["AGENTS.md", "CLAUDE.md"]);
    expect(fs.readlinkSync(path.join(snapshot, "CLAUDE.md"))).toBe("AGENTS.md");
    expect(() =>
      copyIsolatedVitestSource(root, temp.make("isolated-untracked-link-"), ["CLAUDE.md"]),
    ).toThrow("excluded/untracked");
    fs.symlinkSync("/etc/passwd", path.join(root, "outside.ts"));
    expect(() =>
      copyIsolatedVitestSource(root, temp.make("isolated-outside-link-"), ["outside.ts"]),
    ).toThrow("escapes");
  });
  it("projects readonly package trees and relocatable workspace symlinks without cached outputs", () => {
    const root = temp.make("isolated-deps-");
    const snapshot = temp.make("isolated-deps-copy-");
    write(root, "packages/example/package.json", "{}");
    write(root, "node_modules/.pnpm/example/node_modules/dependency/package.json", "{}");
    write(
      root,
      "node_modules/.bin/tool",
      `#!/bin/sh
NODE_PATH='${root}/node_modules'
`,
    );
    write(root, "node_modules/.vite/stale", "old output");
    fs.symlinkSync("../packages/example", path.join(root, "node_modules/example"));
    const copied = copyIsolatedVitestSource(root, snapshot, [
      "packages/example/package.json",
    ]).copied;
    const mounts = prepareIsolatedVitestDependencies(root, snapshot, copied);
    expect(mounts).toEqual([
      { source: path.join(root, "node_modules/.pnpm"), target: "/workspace/node_modules/.pnpm" },
    ]);
    expect(fs.readlinkSync(path.join(snapshot, "node_modules/example"))).toBe(
      "../packages/example",
    );
    expect(fs.readFileSync(path.join(snapshot, "node_modules/.bin/tool"), "utf8")).toContain(
      "/workspace/node_modules",
    );
    expect(fs.existsSync(path.join(snapshot, "node_modules/.vite/stale"))).toBe(false);
    write(root, "node_modules/.pnpm/example/node_modules/dependency/.env", "synthetic-secret");
    const maskedSnapshot = temp.make("isolated-masked-deps-");
    const masked = prepareIsolatedVitestDependencies(root, maskedSnapshot, copied);
    const dotenv = masked.find((mount) => mount.target.endsWith("/.env"));
    expect(dotenv).toBeDefined();
    expect(fs.readFileSync(dotenv!.source, "utf8")).toBe("");
    fs.symlinkSync("/etc/passwd", path.join(root, "node_modules/.pnpm/escape"));
    expect(() =>
      prepareIsolatedVitestDependencies(root, temp.make("isolated-bad-deps-"), copied),
    ).toThrow("escapes");
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
    runIsolatedVitestContainer({
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
  it.each([0, 1, 7])(
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
      const calls: string[][] = [];
      const command: IsolatedPodmanCommand = async (args) => {
        calls.push(args);
        if (args[0] === "create") {
          throw failure;
        }
        return { code: 1, stdout: "" };
      };
      const onAbsent = vi.fn();
      await expect(
        runIsolatedVitestContainer({
          command,
          name,
          createArgs: ["create"],
          verify: vi.fn(),
          onAbsent,
        }),
      ).rejects.toBe(failure);
      expect(calls.at(-1)).toEqual(["container", "exists", name]);
      expect(onAbsent).not.toHaveBeenCalled();
    },
  );
  it("reconciles a failed create without starting or falling back", async () => {
    const fixture = lifecycle({ failCreate: true });
    await expect(fixture.run()).rejects.toThrow("create failed");
    expect(fixture.calls.some((args) => args[0] === "start")).toBe(false);
    expect(fixture.onAbsent).toHaveBeenCalledOnce();
  });
  it("does not start a container whose inspection fails", async () => {
    const fixture = lifecycle({ failVerify: true });
    await expect(fixture.run()).rejects.toThrow("unexpected mounts");
    expect(fixture.calls.some((args) => args[0] === "start")).toBe(false);
    expect(fixture.onAbsent).toHaveBeenCalledOnce();
  });
  it("stops and joins the container after an interrupted attach", async () => {
    const fixture = lifecycle({ failStart: true });
    await expect(fixture.run()).rejects.toThrow("attach interrupted");
    expect(fixture.calls).toContainEqual(["stop", "--time", "5", name]);
    expect(fixture.calls).toContainEqual(["wait", name]);
    expect(fixture.onAbsent).toHaveBeenCalledOnce();
  });
  it("fails closed and retains the snapshot when cleanup cannot be established", async () => {
    const fixture = lifecycle({ failRemove: true });
    await expect(fixture.run()).rejects.toThrow("cleanup failed");
    expect(fixture.onAbsent).not.toHaveBeenCalled();
  });
  it("never removes a container with a different owner label", async () => {
    const fixture = lifecycle({ failCreate: true, label: "another-invocation" });
    await expect(fixture.run()).rejects.toMatchObject({
      message: expect.stringContaining("cleanup failed"),
      errors: [
        expect.any(Error),
        expect.objectContaining({ message: expect.stringContaining("ownership") }),
      ],
    });
    expect(fixture.calls.some((args) => args[0] === "rm")).toBe(false);
    expect(fixture.onAbsent).not.toHaveBeenCalled();
  });
});
