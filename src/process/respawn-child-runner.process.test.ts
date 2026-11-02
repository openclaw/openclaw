import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { CLI_PARENT_BOUND_PRELOAD } from "../../cli-parent-lifetime.mjs";
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
