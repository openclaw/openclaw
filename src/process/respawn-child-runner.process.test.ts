import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLI_PARENT_BOUND_PRELOAD } from "../../cli-parent-lifetime.mjs";
import {
  acquireDistArtifactOwnership,
  resolveDistArtifactLockPath,
} from "../../scripts/lib/dist-artifact-lock.mts";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { waitForDead } from "../../test/helpers/process-wait.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

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

describe.runIf(process.platform !== "win32")("update signal drain under a launcher", () => {
  const fixture = createFixtureLifetime();
  const ownedPids = new Set<number>();
  afterEach(async () => {
    const signal = AbortSignal.timeout(10_000);
    await Promise.all(
      [...ownedPids].map(async (pid) => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already exited; the wait below confirms it.
        }
        await waitForDead(pid, signal, "reject");
      }),
    );
    ownedPids.clear();
    await fixture.cleanup();
  });

  /**
   * A real launcher around a child that takes real checkout ownership and, like the
   * update signal handler, outlasts the generic escalation while joining its work.
   */
  async function startLauncher(
    owner: "entry" | "launcher",
    command: string,
    signal: NodeJS.Signals,
  ) {
    const root = fs.realpathSync(fixture.createTempDir("openclaw-respawn-drain-"));
    fs.mkdirSync(path.join(root, ".git"));
    const childScript = path.join(root, "child.mjs");
    fs.writeFileSync(
      childScript,
      `import { acquireDistArtifactOwnership } from ${moduleUrl("../../scripts/lib/dist-artifact-lock.mts")};
      const lock = await acquireDistArtifactOwnership(${JSON.stringify(root)});
      process.on(${JSON.stringify(signal)}, () => setTimeout(async () => {
        await lock.release();
        process.exit(${JSON.stringify({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal as string])});
      }, 2_500));
      console.log(JSON.stringify({ pid: process.pid }));
      setInterval(() => {}, 1000);`,
    );
    const argv = JSON.stringify(["node", "openclaw", "--profile", "e2e", command]);
    const launch =
      owner === "entry"
        ? `import { resolveRespawnSignalExitGraceMs } from ${moduleUrl("../cli/respawn-policy.ts")};
          import { runRespawnChildWithSignalBridge } from ${moduleUrl("./respawn-child-runner.ts")};
          process.exitCode = await runRespawnChildWithSignalBridge({
            command: process.execPath, args: [${JSON.stringify(childScript)}], env: process.env,
            detachForProcessTree: true, onError: console.error,
            signalExitGraceMs: resolveRespawnSignalExitGraceMs(${argv}),
          });`
        : `import { runRespawnedChild } from ${moduleUrl("../../node-runtime-recovery.mjs")};
          process.argv = ${argv};
          await runRespawnedChild({
            command: process.execPath, args: [${JSON.stringify(childScript)}], env: process.env,
          });`;
    const launcher = spawn(
      resolveTestNodeExecPath(),
      ["--import", import.meta.resolve("tsx"), ...moduleArgs, launch],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    ownedPids.add(launcher.pid!);
    const [data] = (await Promise.race([
      once(launcher.stdout, "data"),
      once(launcher, "close").then((result) => {
        throw new Error(`Launcher exited before ownership: ${JSON.stringify(result)}`);
      }),
    ])) as [Buffer];
    ownedPids.add((JSON.parse(data.toString()) as { pid: number }).pid);
    return {
      root,
      launcher,
      closed: once(launcher, "close") as Promise<[number | null, NodeJS.Signals | null]>,
      ownerPath: path.join(resolveDistArtifactLockPath(root), "owner.json"),
    };
  }

  it.each([
    { owner: "entry", signal: "SIGTERM", code: 143 },
    { owner: "entry", signal: "SIGINT", code: 130 },
    { owner: "entry", signal: "SIGHUP", code: 129 },
    { owner: "launcher", signal: "SIGTERM", code: 143 },
  ] as const)(
    "lets an update finish its $signal drain under the $owner launcher, release and exit $code",
    { timeout: 20_000 },
    async ({ owner, signal, code }) => {
      const run = await startLauncher(owner, "update", signal);
      expect(fs.existsSync(run.ownerPath)).toBe(true);
      run.launcher.kill(signal);
      await expect(run.closed).resolves.toEqual([code, null]);
      expect(fs.existsSync(run.ownerPath)).toBe(false);
    },
  );

  it.each(["entry", "launcher"] as const)(
    "keeps the %s launcher's backstop for other commands, and the next owner recovers",
    { timeout: 20_000 },
    async (owner) => {
      const run = await startLauncher(owner, "status", "SIGTERM");
      run.launcher.kill("SIGTERM");
      // The wrapper escalates to SIGKILL and mirrors that fate: the incident's status 137.
      await expect(run.closed).resolves.toEqual([null, "SIGKILL"]);
      expect(fs.existsSync(run.ownerPath)).toBe(true);
      const lock = await acquireDistArtifactOwnership(run.root);
      await lock.release();
      expect(fs.existsSync(run.ownerPath)).toBe(false);
    },
  );
});
