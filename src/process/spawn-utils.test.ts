import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireWorkspaceResultGit } from "../gateway/worker-environments/workspace-result-git.js";
import { runWorkspaceInventoryCommandToFile } from "../gateway/worker-environments/workspace-sync-inventory.js";
import { setDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import { executeGitCommand, executeGitCommandBuffered } from "../infra/git-exec.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { spawnCommand } from "./exec-spawn.js";
import { prepareOomScoreAdjustedSpawn } from "./linux-oom-score.js";
import { runWithSpawnBroker } from "./spawn-broker/context.js";
import { createSpawnBrokerHost } from "./spawn-broker/host.js";
import { supportsSpawnBrokerCommandTransport } from "./spawn-broker/pipe.js";
import {
  recordChildProcessSpawn,
  withChildProcessOperation,
  withGitProcessOperation,
} from "./spawn-diagnostics.js";
import { useSpawnDiagnostics } from "./spawn-diagnostics.test-support.js";
import { spawnProcess, spawnAndWait } from "./spawn-utils.js";

function sample(family: string, operation: string, count = 1, intervalMs?: number) {
  const fields = { family, operation, count };
  return expect.objectContaining(intervalMs === undefined ? fields : { ...fields, intervalMs });
}

function observeSpawn(command: string, args: readonly string[] = []) {
  const child = new EventEmitter() as ChildProcess;
  recordChildProcessSpawn(command, child, undefined, args);
  return child;
}

function emitSpawn(command: string, args: readonly string[] = []) {
  observeSpawn(command, args).emit("spawn");
}

it("spawnAndWait rejects ENOENT from a real missing executable", async () => {
  await withTempDir("openclaw-spawn-missing-", async (dir) => {
    await expect(
      spawnAndWait({ argv: [path.join(dir, "missing")], options: { stdio: "ignore" } }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("child-process spawn diagnostics", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const { events, sampleAt } = useSpawnDiagnostics();

  function expectSample(expected: unknown[], forbidden = /private/) {
    sampleAt(60_000);
    expect(events).toEqual(expected);
    expect(JSON.stringify(events)).not.toMatch(forbidden);
  }

  async function checkSuccessfulSpawns() {
    const outputRoot = tempDirs.make("openclaw-spawn-counts-");
    const inventory = (name: string) =>
      runWorkspaceInventoryCommandToFile({
        argv: ["git", "--version"],
        outputPath: path.join(outputRoot, name),
        signal: new AbortController().signal,
        timeoutMs: 10_000,
      });
    const missing = path.join(outputRoot, "missing");
    const native = (command: string, args: string[] = []) =>
      once(spawnProcess(command, args, { stdio: "ignore" }), "close");
    expect((await native(process.execPath, ["-e", ""]))[0]).toBe(0);
    await expect(spawnCommand([process.execPath, "-e", ""])).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(native(missing)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(spawnCommand([missing])).rejects.toMatchObject({ code: "ENOENT" });
    await Promise.all([
      executeGitCommand(process.cwd(), ["--version"], { operation: "project.clone" }),
      executeGitCommandBuffered(process.cwd(), ["--version"], { operation: "publication" }),
      executeGitCommand(process.cwd(), ["--version"], { lowerPriority: true }),
      native("git", ["--version"]),
      requireWorkspaceResultGit(process.cwd(), ["--version"]),
      withGitProcessOperation("workspace.result-cleanup", () =>
        requireWorkspaceResultGit(process.cwd(), ["--version"]),
      ),
      inventory("inventory"),
      withGitProcessOperation("workspace.sync", () => inventory("sync-inventory")),
    ]);
    sampleAt(59_999);
    expect(events).toEqual([]);
    sampleAt(90_000);
    expect(events).toEqual(
      expect.arrayContaining([
        sample(process.versions.bun ? "bun" : "node", "unscoped.runtime", 2, 90_000),
        ...[
          "project.clone",
          "publication",
          "workspace.result",
          "workspace.result-cleanup",
          "workspace.inventory",
          "workspace.sync",
        ].map((operation) => sample("git", operation, 1, 90_000)),
        sample("git", "unscoped.version", 2),
      ]),
    );
    sampleAt(150_000);
    expect(events).toHaveLength(8);
  }

  it("counts native and command launches once, excluding failures", checkSuccessfulSpawns);

  it.skipIf(!supportsSpawnBrokerCommandTransport())(
    "counts successful broker requests once without counting the broker transport",
    async () => {
      const host = createSpawnBrokerHost();
      try {
        await host.ready();
        await runWithSpawnBroker(host, checkSuccessfulSpawns);
      } finally {
        await host.close();
      }
    },
  );

  it("bounds labels to command families and discards disabled observations", () => {
    for (const command of ["/private/helper-secret", "C:\\private\\Git.EXE", "/bin/bun"]) {
      emitSpawn(command);
    }
    expectSample([
      sample("other", "unscoped.command"),
      sample("git", "unscoped.other"),
      sample("bun", "unscoped.runtime"),
    ]);

    const pending = observeSpawn("node");
    setDiagnosticsEnabledForProcess(false);
    pending.emit("spawn");
    recordChildProcessSpawn("node", pending);
    pending.emit("spawn");
    sampleAt(120_000);
    setDiagnosticsEnabledForProcess(true);
    sampleAt(180_000);
    expect(events).toHaveLength(3);
  });

  it("captures bounded Git owners before deferred spawn events without leaking scope", () => {
    const first = withGitProcessOperation("checkout.diff", () => observeSpawn("git"));
    const second = withGitProcessOperation("repository.identities", () => observeSpawn("git"));
    const unknown = new EventEmitter() as ChildProcess;
    Reflect.apply(withGitProcessOperation, undefined, [
      "/private/customer/repo",
      () => recordChildProcessSpawn("git", unknown),
    ]);
    second.emit("spawn");
    first.emit("spawn");
    unknown.emit("spawn");
    expectSample([
      sample("git", "repository.identities"),
      sample("git", "checkout.diff"),
      sample("git", "unknown"),
    ]);
  });

  it("captures owners across async preparation without replacing explicit Git owners", async () => {
    const owner = "service.relay";
    const [{ first, git }, second] = await Promise.all([
      withChildProcessOperation("agent.exec", async () => {
        await Promise.resolve();
        return {
          first: withChildProcessOperation(
            "service.relay",
            () => observeSpawn("bash", ["-c", "private"]),
            "default",
          ),
          git: withGitProcessOperation("checkout.diff", () => observeSpawn("git")),
        };
      }),
      withChildProcessOperation(owner, async () => {
        await Promise.resolve();
        return observeSpawn("node");
      }),
    ]);
    const unknown = new EventEmitter() as ChildProcess;
    Reflect.apply(withChildProcessOperation, undefined, [
      "/private/customer",
      () => recordChildProcessSpawn("helper", unknown),
    ]);
    for (const child of [second, first, git, unknown]) {
      child.emit("spawn");
    }
    expectSample([
      sample("node", owner),
      sample("bash", "agent.exec"),
      sample("git", "checkout.diff"),
      sample("other", "unknown"),
    ]);
  });

  it.each([
    ["sh", ["-lc", "private"], "sh", "shell-command"],
    ["bash", ["/private/script"], "bash", "shell"],
    ["bash", ["-ce", "private"], "bash", "shell-command"],
    ["bash", ["-cx", "private"], "bash", "shell-command"],
    ["bash", ["/private/script", "-c", "private"], "bash", "shell"],
    ["node", ["--eval", "private"], "node", "runtime"],
    ["bun", ["--print=private"], "bun", "runtime"],
    ["/private/tool", ["--version"], "other", "version"],
    ["/private/bin/gh", ["api", "/private/request"], "other", "gh"],
    ["bash", ["-v", "-c", "private"], "bash", "shell-command"],
    ["curl", ["-v", "private-url"], "other", "curl"],
    ["node", ["-v"], "node", "version"],
    ["powershell.exe", ["-NoProfile", "-Command", "private"], "powershell", "shell-command"],
    ["pwsh", ["-EncodedCommand", "private"], "pwsh", "shell-command"],
    ["pwsh", ["/C", "private"], "pwsh", "shell-command"],
    ["pwsh", ["-File", "/private/script", "-Command", "private"], "pwsh", "shell"],
  ])("bounds unscoped %s launch classification", (command, args, family, operation) => {
    emitSpawn(command, args);
    expectSample([sample(family, `unscoped.${operation}`)]);
  });

  it("attributes owner-prepared OOM shims to their logical targets", () => {
    for (const [command, args] of [
      ["git", ["status"]],
      ["node", ["-e", "private code"]],
    ] as const) {
      const prepared = prepareOomScoreAdjustedSpawn(command, args, {
        platform: "linux",
        env: {},
        shellAvailable: () => true,
      });
      emitSpawn(prepared.command, prepared.args);
    }
    expectSample([sample("git", "unscoped.status"), sample("node", "unscoped.runtime")]);
  });

  it.each([
    [["-C", "/private", "-c", "alias.secret=status", "config", "--get", "user.email"], "config"],
    [["--git-dir=/private", "--no-pager", "rev-parse", "private-ref"], "rev-parse"],
    [["--config-env", "secret=PRIVATE_VALUE", "--work-tree", "/private", "status"], "status"],
    [["-c", "alias.private-command=status", "private-command"], "other"],
    [["--unknown-option", "config"], "other"],
    [["--no-lazy-fetch", "version"], "version"],
    [["-C", "/private", "--no-lazy-fetch", "cat-file", "--batch-check"], "cat-file"],
    [["fsck", "--connectivity-only"], "fsck"],
    [["ls-remote", "private-remote", "private-ref"], "ls-remote"],
    [["rebase", "private-ref"], "rebase"],
    [["reflog", "expire", "--all"], "reflog"],
    [["--attr-source=private-ref", "checkout-index", "-a"], "checkout-index"],
  ])("classifies unscoped Git argv %j without exporting its values", (args, operation) => {
    emitSpawn("git", args);
    expectSample([sample("git", `unscoped.${operation}`)], /private|secret|PRIVATE_VALUE/);
  });
});
