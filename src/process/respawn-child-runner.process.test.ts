import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { CLI_PARENT_BOUND_PRELOAD } from "../../cli-parent-lifetime.mjs";
import { withinTest } from "../../test/helpers/promise.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";

const moduleArgs = ["--input-type=module", "-e"];
const moduleUrl = (file: string) => JSON.stringify(new URL(file, import.meta.url).href);

it.each([
  { lifetime: "complete", transport: "preload" },
  { lifetime: "parent-bound", transport: "preload" },
  { lifetime: "complete", transport: "env" },
  { lifetime: "parent-bound", transport: "env" },
] as const)(
  "respawn lifetime preserves $lifetime completion through $transport",
  async ({ lifetime, transport }) => {
    const preload = transport === "preload" ? ["--import", CLI_PARENT_BOUND_PRELOAD] : [];
    const source = `
      import { watchCliRespawnParent, getCliParentPid } from ${moduleUrl("../../cli-parent-lifetime.mjs")};
      watchCliRespawnParent();
      const timer = ${lifetime === "complete" ? "undefined" : "setInterval(() => {}, 1000)"};
      process.once("SIGTERM", () => { clearInterval(timer); process.stdout.write("settled"); });

      process.send({ parent: getCliParentPid(), marker: process.env.OPENCLAW_CLI_RESPAWN_PARENT,
        inheritedPreload: process.execArgv.some(arg => arg.startsWith("data:text/javascript,")) });
    `;
    const child = spawn(resolveTestNodeExecPath(), [...preload, ...moduleArgs, source], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        ...(transport === "env" ? { OPENCLAW_CLI_RESPAWN_PARENT: String(process.pid) } : {}),
      },
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    const exited = once(child, "exit");
    try {
      const [message] = await once(child, "message");
      expect(message).toEqual({ parent: process.pid, inheritedPreload: false });
      if (lifetime === "parent-bound") {
        child.disconnect();
      }
      expect(await exited).toEqual([0, null]);
      expect(stdout).toBe(lifetime === "parent-bound" ? "settled" : "");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await exited;
    }
  },
);

it.for(["preload", "env", "unbound", "mismatched"] as const)(
  "late watcher preserves %s custody after its real launcher exits",
  async (transport, { signal }) => {
    const bound = transport === "preload" || transport === "env";
    const source = `
      import assert from "node:assert/strict";
      import { watchCliRespawnParent, getCliParentPid } from ${moduleUrl("../../cli-parent-lifetime.mjs")};
      const timer = setInterval(() => {}, 1000);
      let signals = 0;
      process.on("SIGTERM", () => { signals++; clearInterval(timer); });
      process.once("disconnect", () => {
        assert.equal(process.connected, false);
        assert.equal(process.channel, null);
        watchCliRespawnParent();
        watchCliRespawnParent();
        assert.equal(signals, ${bound ? 1 : 0}, "only an admitted parent may dispatch termination once");
        if (!${bound}) clearInterval(timer);
        process.stdout.write("settled");
      });
      process.send({ pid: process.pid, parent: getCliParentPid(),
        marker: process.env.OPENCLAW_CLI_RESPAWN_PARENT });
    `;
    const args = [
      ...(transport === "preload" ? ["--import", CLI_PARENT_BOUND_PRELOAD] : []),
      ...moduleArgs,
      source,
    ];
    // The launcher exits only after parent admission; inherited pipes keep close
    // pending until its child settles, without a parent-side disconnect shortcut.
    const launcher = spawn(
      resolveTestNodeExecPath(),
      [
        ...moduleArgs,
        `
      import { spawn } from "node:child_process";
      const child = spawn(process.execPath, ${JSON.stringify(args)}, {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: { ...process.env, ...(${transport === "env" || transport === "mismatched"} ? { OPENCLAW_CLI_RESPAWN_PARENT: String(process.pid + ${transport === "mismatched" ? 1 : 0}) } : {}) },
      });
      child.once("message", message => process.send(message, () => process.exit(0)));
    `,
      ],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    const closed = once(launcher, "close");
    let stdout = "";
    let stderr = "";
    let childPid: number | undefined;
    launcher.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    launcher.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    try {
      const [message] = await withinTest(once(launcher, "message"), signal);
      childPid = message.pid;
      expect(message).toEqual({ pid: childPid, ...(bound ? { parent: launcher.pid } : {}) });
      expect(await withinTest(closed, signal), stderr).toEqual([0, null]);
      expect(stdout, stderr).toBe("settled");
    } finally {
      killPidIfAlive(childPid);
      if (launcher.exitCode === null && launcher.signalCode === null) {
        launcher.kill("SIGKILL");
      }
      await closed;
    }
  },
);

it.each(["preload", "env"])("preserves a bound %s Node process without IPC", (transport) => {
  const result = spawnSync(
    resolveTestNodeExecPath(),
    [
      ...(transport === "preload" ? ["--import", CLI_PARENT_BOUND_PRELOAD] : []),
      ...moduleArgs,
      `
        import assert from "node:assert/strict";
        import { watchCliRespawnParent } from ${moduleUrl("../../cli-parent-lifetime.mjs")};
        assert.equal(process.connected, undefined);
        watchCliRespawnParent();
        process.stdout.write("complete");
      `,
    ],
    {
      env: { ...process.env, OPENCLAW_CLI_RESPAWN_PARENT: String(process.pid) },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect({ code: result.status, signal: result.signal }, result.stderr).toEqual({
    code: 0,
    signal: null,
  });
  expect(result.stdout).toBe("complete");
});

it.runIf(process.platform !== "win32").each([
  { owner: "entry", signal: true },
  { owner: "entry", signal: false },
  { owner: "launcher", signal: true },
  { owner: "launcher", signal: false },
])(
  "preserves real $owner child-only signal versus numeric completion (signal=$signal)",
  ({ owner, signal }) => {
    const child = signal
      ? "process.stdout.write('settled-output', () => process.kill(process.pid, 'SIGKILL'));"
      : "process.stdout.write('settled-output'); process.exitCode = 143;";
    const [module, run]: [string, string] =
      owner === "entry"
        ? ["./respawn-child-runner.ts", "runRespawnChildWithSignalBridge"]
        : ["../../node-runtime-recovery.mjs", "runRespawnedChild"];
    const source = `
      import { ${run} as run } from ${moduleUrl(module)};
      ${owner === "entry" ? "process.exitCode = " : ""}await run({
        command: process.execPath, args: ['-e', ${JSON.stringify(child)}], env: {},
        ${owner === "entry" ? "onError: console.error" : ""}
      });`;
    const result = spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), ...moduleArgs, source],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe("settled-output");
    expect({ code: result.status, signal: result.signal }, result.stderr).toEqual(
      signal ? { code: null, signal: "SIGKILL" } : { code: 143, signal: null },
    );
  },
);

it.runIf(process.platform !== "win32").each([
  { owner: "entry", command: "update", closed: [143, null] },
  { owner: "launcher", command: "--update", closed: [143, null] },
  { owner: "entry", command: "status", closed: [null, "SIGKILL"] },
  { owner: "launcher", command: "status", closed: [null, "SIGKILL"] },
] as const)(
  "$owner launcher lets only update ($command) outlast the generic signal escalation",
  { timeout: 20_000 },
  async ({ owner, command, closed }) => {
    // Like the update signal handler, the child needs longer than the generic 2s backstop.
    const child =
      "process.on('SIGTERM', () => setTimeout(() => process.exit(143), 2_500));" +
      "process.stdout.write('ready'); setInterval(() => {}, 1000);";
    const [module, run]: [string, string] =
      owner === "entry"
        ? ["./respawn-child-runner.ts", "runRespawnChildWithSignalBridge"]
        : ["../../node-runtime-recovery.mjs", "runRespawnedChild"];
    const source = `
      import { ${run} as run } from ${moduleUrl(module)};
      process.argv = ${JSON.stringify(["node", "openclaw", "--profile", "e2e", command])};
      ${owner === "entry" ? "process.exitCode = " : ""}await run({
        command: process.execPath, args: ['-e', ${JSON.stringify(child)}], env: {},
        ${owner === "entry" ? "onError: console.error" : ""}
      });`;
    const launcher = spawn(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), ...moduleArgs, source],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = once(launcher, "close");
    try {
      await once(launcher.stdout, "data");
      launcher.kill("SIGTERM");
      expect(await exited).toEqual(closed);
    } finally {
      if (launcher.exitCode === null && launcher.signalCode === null) {
        launcher.kill("SIGKILL");
      }
      await exited;
    }
  },
);
