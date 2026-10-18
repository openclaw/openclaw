import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireWorkspaceResultGit } from "../gateway/worker-environments/workspace-result-git.js";
import { runWorkspaceInventoryCommandToFile } from "../gateway/worker-environments/workspace-sync-inventory.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { executeGitCommand, executeGitCommandBuffered } from "../infra/git-exec.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { spawnCommand } from "./exec-spawn.js";
import { prepareOomScoreAdjustedSpawn } from "./linux-oom-score.js";
import { runWithSpawnBroker } from "./spawn-broker/context.js";
import { createSpawnBrokerHost } from "./spawn-broker/host.js";
import { supportsSpawnBrokerCommandTransport } from "./spawn-broker/pipe.js";
import {
  emitChildProcessSpawnSample,
  recordChildProcessSpawn,
  withChildProcessOperation,
  withGitProcessOperation,
} from "./spawn-diagnostics.js";
import { spawnProcess, spawnAndWait } from "./spawn-utils.js";

function sample(family: string, operation: string, count = 1, intervalMs?: number) {
  const fields = { family, operation, count };
  return expect.objectContaining(intervalMs === undefined ? fields : { ...fields, intervalMs });
}

function emitSpawn(command: string, args: readonly string[] = []) {
  const child = new EventEmitter() as ChildProcess;
  recordChildProcessSpawn(command, child, undefined, args);
  child.emit("spawn");
}

describe("spawnAndWait", () => {
  it("rejects ENOENT from a real missing executable", async () => {
    await withTempDir("openclaw-spawn-missing-", async (dir) => {
      await expect(
        spawnAndWait({
          argv: [path.join(dir, "missing-executable")],
          options: { stdio: "ignore" },
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

describe("child-process spawn diagnostics", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let now: number;
  let events: DiagnosticEventPayload[];
  let stop: () => void;

  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    resetDiagnosticEventsForTest();
    setDiagnosticsEnabledForProcess(false);
    emitChildProcessSpawnSample();
    setDiagnosticsEnabledForProcess(true);
    events = [];
    stop = onDiagnosticEvent((event) => {
      if (event.type === "diagnostic.child_process.spawn") {
        events.push(event);
      }
    });
  });

  afterEach(() => {
    stop();
    setDiagnosticsEnabledForProcess(false);
    emitChildProcessSpawnSample();
    resetDiagnosticEventsForTest();
    vi.restoreAllMocks();
  });

  function expectSample(expected: unknown[], forbidden = /private/) {
    now = 60_000;
    emitChildProcessSpawnSample();
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
    const child = spawnProcess(process.execPath, ["-e", ""], { stdio: "ignore" });
    expect((await once(child, "close"))[0]).toBe(0);
    await expect(spawnCommand([process.execPath, "-e", ""])).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(
      once(spawnProcess(missing, [], { stdio: "ignore" }), "close"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(spawnCommand([missing])).rejects.toMatchObject({ code: "ENOENT" });
    await Promise.all([
      executeGitCommand(process.cwd(), ["--version"], { operation: "project.clone" }),
      executeGitCommandBuffered(process.cwd(), ["--version"], { operation: "publication" }),
      executeGitCommand(process.cwd(), ["--version"], { lowerPriority: true }),
      once(spawnProcess("git", ["--version"], { stdio: "ignore" }), "close"),
      requireWorkspaceResultGit(process.cwd(), ["--version"]),
      withGitProcessOperation("workspace.result-cleanup", () =>
        requireWorkspaceResultGit(process.cwd(), ["--version"]),
      ),
      inventory("inventory"),
      withGitProcessOperation("workspace.sync", () => inventory("sync-inventory")),
    ]);
    now = 59_999;
    emitChildProcessSpawnSample();
    expect(events).toEqual([]);
    now = 90_000;
    emitChildProcessSpawnSample();
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
    now = 150_000;
    emitChildProcessSpawnSample();
    expect(events).toHaveLength(8);
  }

  it(
    "counts successful native and command launches once, excluding failures",
    checkSuccessfulSpawns,
  );

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
    for (const command of [
      "/private/customer/helper-secret",
      "C:\\private\\Git.EXE",
      "/usr/local/bin/bun",
    ]) {
      emitSpawn(command);
    }
    expectSample([
      sample("other", "unscoped.command"),
      sample("git", "unscoped.other"),
      sample("bun", "unscoped.runtime"),
    ]);

    const pending = new EventEmitter() as ChildProcess;
    recordChildProcessSpawn("node", pending);
    setDiagnosticsEnabledForProcess(false);
    pending.emit("spawn");
    recordChildProcessSpawn("node", pending);
    pending.emit("spawn");
    now = 120_000;
    emitChildProcessSpawnSample();
    setDiagnosticsEnabledForProcess(true);
    now = 180_000;
    emitChildProcessSpawnSample();
    expect(events).toHaveLength(3);
  });

  it("captures bounded Git owners before deferred spawn events without leaking scope", () => {
    const first = new EventEmitter() as ChildProcess;
    const second = new EventEmitter() as ChildProcess;
    const unknown = new EventEmitter() as ChildProcess;
    withGitProcessOperation("checkout.diff", () => recordChildProcessSpawn("git", first));
    withGitProcessOperation("repository.identities", () => recordChildProcessSpawn("git", second));
    Reflect.apply(withGitProcessOperation, undefined, [
      "/private/customer/repo",
      () => {
        recordChildProcessSpawn("git", unknown);
      },
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
    const first = new EventEmitter() as ChildProcess;
    const second = new EventEmitter() as ChildProcess;
    const git = new EventEmitter() as ChildProcess;
    await Promise.all([
      withChildProcessOperation("agent.exec", async () => {
        await Promise.resolve();
        withChildProcessOperation(
          "service.relay",
          () => recordChildProcessSpawn("bash", first, undefined, ["-c", "private command"]),
          "default",
        );
        withGitProcessOperation("checkout.diff", () => recordChildProcessSpawn("git", git));
      }),
      withChildProcessOperation(owner, async () => {
        await Promise.resolve();
        recordChildProcessSpawn("node", second);
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
    ["sh", ["-lc", "private command"], "sh", "unscoped.shell-command"],
    ["bash", ["/private/script"], "bash", "unscoped.shell"],
    ["bash", ["-ce", "private command"], "bash", "unscoped.shell-command"],
    ["bash", ["-cx", "private command"], "bash", "unscoped.shell-command"],
    ["bash", ["/private/script", "-c", "private arg"], "bash", "unscoped.shell"],
    ["node", ["--eval", "private code"], "node", "unscoped.runtime"],
    ["bun", ["--print=private code"], "bun", "unscoped.runtime"],
    ["/private/tool", ["--version"], "other", "unscoped.version"],
    ["/private/bin/gh", ["api", "/private/request"], "other", "unscoped.gh"],
    ["bash", ["-v", "-c", "private command"], "bash", "unscoped.shell-command"],
    ["curl", ["-v", "private-url"], "other", "unscoped.curl"],
    ["node", ["-v"], "node", "unscoped.version"],
    [
      "powershell.exe",
      ["-NoProfile", "-Command", "private command"],
      "powershell",
      "unscoped.shell-command",
    ],
    ["pwsh", ["-EncodedCommand", "private-payload"], "pwsh", "unscoped.shell-command"],
    ["pwsh", ["/C", "private command"], "pwsh", "unscoped.shell-command"],
    ["pwsh", ["-File", "/private/script", "-Command", "private arg"], "pwsh", "unscoped.shell"],
  ])("bounds unscoped %s launch classification", (command, args, family, operation) => {
    emitSpawn(command, args);
    expectSample([sample(family, operation)]);
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
    [
      ["-C", "/private/repo", "-c", "alias.secret=status", "config", "--get", "user.email"],
      "unscoped.config",
    ],
    [["--git-dir=/private/repo", "--no-pager", "rev-parse", "private-ref"], "unscoped.rev-parse"],
    [
      ["--config-env", "secret=PRIVATE_VALUE", "--work-tree", "/private/tree", "status"],
      "unscoped.status",
    ],
    [["-c", "alias.private-command=status", "private-command"], "unscoped.other"],
    [["--unknown-option", "config"], "unscoped.other"],
    [["--no-lazy-fetch", "version"], "unscoped.version"],
    [["-C", "/private/repo", "--no-lazy-fetch", "cat-file", "--batch-check"], "unscoped.cat-file"],
    [["fsck", "--connectivity-only"], "unscoped.fsck"],
    [["ls-remote", "private-remote", "private-ref"], "unscoped.ls-remote"],
    [["rebase", "private-ref"], "unscoped.rebase"],
    [["reflog", "expire", "--all"], "unscoped.reflog"],
    [["--attr-source=private-ref", "checkout-index", "-a"], "unscoped.checkout-index"],
  ])("classifies unscoped Git argv %j without exporting its values", (args, operation) => {
    emitSpawn("git", args);
    expectSample([sample("git", operation)], /private|secret|PRIVATE_VALUE/);
  });
});
