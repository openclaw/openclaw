import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, beforeEach, expect, it, vi } from "vitest";
import { fixtureReceiptClientSource } from "../../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../../test/helpers/promise.js";
import { getGatewayServiceUpdateNativeCommand } from "../../daemon/service-update-authority.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import * as processRunner from "../../process/exec.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
  type UpdateCommandChildGrant,
  type UpdateCommandExecutor,
} from "./update-command-executor.js";
import { useExecutorFixture, useExecutorReceipts } from "./update-command-executor.test-support.js";
import { prepareUpdateCommandNativeGate } from "./update-command-native-gate.js";
import { createPackageRuntimeRecovery } from "./update-command-node-runtime.js";
import { withRetainedUpdateServiceAuthority } from "./update-command-retained-service.js";

const fixture = useExecutorFixture("auxiliary-node-owner-", { splitRoots: true });
const receipts = useExecutorReceipts();
const nodeExecPath = resolveTestNodeExecPath();
let root: string;
let serviceRoot: string;
let run: NonNullable<UpdateCommandOptions["run"]>;
beforeEach(() => {
  run = { runId: randomUUID(), env: process.env };
  ({ root, serviceRoot } = fixture());
});

function withOwner<T>(
  operation: (fence: UpdateRecoveryFence, executor: UpdateCommandExecutor) => Promise<T>,
  preflight = true,
) {
  return withUpdateCommandExecutor(run.runId, async (executor) => {
    const fence = await executor.enter(root, {
      serviceRoot,
      preflight: preflight ? true : undefined,
    });
    run.executorFence = fence;
    return operation(fence, executor);
  });
}

function expectReleased(...keys: string[]) {
  for (const key of keys.length ? keys : [root, serviceRoot]) {
    expect(createManagedHandoffLeaseStore().read(key)).toEqual({ kind: "absent" });
  }
}

function expectBusy(...keys: string[]) {
  for (const key of keys) {
    expect(
      createManagedHandoffLeaseStore().acquire(key, "contender", { kind: "update" }).kind,
    ).toBe("busy");
  }
}

function expectReleaseRefused(fence: UpdateRecoveryFence, reason = "not current") {
  expect(() => releaseUpdateCommandPreflightForHandoff(fence)).toThrow(reason);
}

function runBoundChild(
  _grant: UpdateCommandChildGrant,
  beforeInput: (pid: number, argv?: readonly string[]) => void,
  program = "require('node:fs').readFileSync(0,'utf8')",
  killGraceMs?: number,
) {
  return runUtf8CommandWithTimeout([process.execPath, "-e", program], {
    input: "",
    beforeInput,
    timeoutMs: 10000,
    killProcessTree: true,
    requireProcessTreeExtinction: true,
    killGraceMs,
  });
}

function preloadFixture(kind: "require" | "import") {
  const marker = path.join(root, "preload-effect");
  const preload = path.join(root, "préload option.cjs");
  fs.writeFileSync(
    preload,
    `require('node:fs').appendFileSync(${JSON.stringify(marker)},process.pid+'\\n');`,
  );
  const value = kind === "import" ? pathToFileURL(preload).href : preload;
  return { marker, env: { ...process.env, NODE_OPTIONS: `--${kind}=${JSON.stringify(value)}` } };
}

function effectArgs(effect: string, value = "'unauthorized'") {
  return ["-e", `require('node:fs').writeFileSync(${JSON.stringify(effect)},${value})`];
}

function installer(
  params: Partial<Omit<Parameters<typeof createPackageRuntimeRecovery>[0], "root">> = {},
) {
  const recovery = createPackageRuntimeRecovery({
    root,
    opts: { run },
    timeoutMs: 10000,
    ...params,
  });
  assert(recovery.installCommand);
  return recovery.installCommand;
}

it.for(["initializing", "admitted"] as const)(
  "preserves direct preflight release through a healthy installer child and active drain: %s",
  async (phase, { signal }) => {
    const ready = path.join(root, "ready");
    const proceed = path.join(root, "proceed");
    const preload = preloadFixture(phase === "admitted" ? "require" : "import");
    if (phase === "admitted") {
      const runCommand = processRunner.runCommandWithTimeout;
      vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation((argv, options) => {
        assert(typeof options !== "number" && typeof options.input === "string");
        expect(Buffer.byteLength(options.input)).toBeGreaterThan(options.input.length);
        // Split the private frame deterministically; OS pipe writes may coalesce UTF-8 fragments.
        const receiver = path.join(root, "fragment-input.cjs");
        fs.writeFileSync(
          receiver,
          `const { Readable } = require("node:stream");
           const stdin = process.stdin;
           const fragmented = Readable.from((async function* () {
             for await (const part of stdin) {
               for (const byte of part) yield Buffer.from([byte]);
             }
           })());
           Object.defineProperty(process, "stdin", { value: fragmented });`,
        );
        return runCommand([argv[0]!, "--require", receiver, ...argv.slice(1)], options);
      });
    }
    await withOwner(async (fence, executor) => {
      const install = installer({
        opts: phase === "admitted" ? { run } : {},
        executorFence: phase === "initializing" ? fence : undefined,
      });
      const installing = install(
        nodeExecPath,
        [
          "--input-type=module",
          "-e",
          `${fixtureReceiptClientSource(receipts.channel.endpoint)}
          import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,nodeOptions:process.env.NODE_OPTIONS}));sendReceipt(${JSON.stringify(ready)},"ready");const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(proceed)})){clearInterval(timer)}},10);`,
        ],
        preload.env,
      );
      try {
        await withinTest(receipts.ready(ready, installing), signal);
        expectReleaseRefused(fence, "The update process is still running.");
        await expect(executor.enter(root, { serviceRoot })).rejects.toThrow(
          "The update process is still running.",
        );
        expectBusy(root, serviceRoot);
      } finally {
        fs.writeFileSync(proceed, "continue");
      }
      expect(await installing).toBe(0);
      const payload = JSON.parse(fs.readFileSync(ready, "utf8"));
      expect(payload.nodeOptions).toBe(preload.env.NODE_OPTIONS);
      expect(fs.readFileSync(preload.marker, "utf8")).toBe(`${payload.pid}\n`);
      releaseUpdateCommandPreflightForHandoff(fence);
      expect(() => fence.assertCurrent()).toThrow();
    });
    expectReleased();
  },
);

it.each(["nonzero", "timeout", "unsettled", "operation", "candidate-busy"] as const)(
  "caught auxiliary failure never restores handoff eligibility: %s",
  async (failure) => {
    const work = withOwner(async (fence) => {
      if (failure === "nonzero" || failure === "timeout" || failure === "unsettled") {
        const install = installer({
          timeoutMs: failure === "timeout" ? 150 : 10000,
        });
        const childCode =
          "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready')";
        const unsettled = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>{child.disconnect();child.unref()});`;
        await expect(
          install(
            process.execPath,
            [
              "-e",
              failure === "nonzero"
                ? "process.exit(2)"
                : failure === "unsettled"
                  ? unsettled
                  : "setInterval(()=>{},1000)",
            ],
            process.env,
          ),
        ).rejects.toThrow("did not complete");
      } else {
        const candidate = path.join(root, "candidate");
        fs.mkdirSync(candidate);
        const store = createManagedHandoffLeaseStore();
        const incumbent =
          failure === "candidate-busy"
            ? store.acquire(candidate, "other-owner", { kind: "update" })
            : undefined;
        try {
          await expect(
            withUpdateCommandExecutorChild(
              fence,
              candidate,
              async (grant, beforeInput) => {
                await runBoundChild(grant, beforeInput);
                throw new Error("fixture operation failed");
              },
              { auxiliaryPreflight: true },
            ),
          ).rejects.toThrow();
        } finally {
          if (incumbent?.kind === "acquired") {
            expect([store.current(incumbent.lease), store.release(incumbent.lease)]).toEqual([
              true,
              true,
            ]);
          }
        }
      }
      expectReleaseRefused(fence);
      // A later healthy auxiliary call may not re-arm the deleted entry.
      await withUpdateCommandExecutorChild(fence, root, runBoundChild, {
        auxiliaryPreflight: true,
      });
      expectReleaseRefused(fence);
    });
    // The original child failure remains sticky even if the caller catches it.
    await expect(work).rejects.toThrow();
  },
);

it.each(["ordinary", "promote-before", "promote-after"] as const)(
  "does not re-arm a non-preflight owner after %s",
  async (scenario) => {
    await withOwner(async (fence, executor) => {
      if (scenario === "promote-before") {
        await executor.enter(root, { serviceRoot });
      }
      await withUpdateCommandExecutorChild(
        fence,
        root,
        runBoundChild,
        scenario === "ordinary" ? undefined : { auxiliaryPreflight: true },
      );
      if (scenario === "promote-after") {
        await executor.enter(root, { serviceRoot });
      }
      expectReleaseRefused(fence);
      fence.assertCurrent();
    });
  },
);

it("keeps B extra-child custody after partial preflight release without reactivating B", async () => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000);process.send('ready')"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const exited = once(child, "exit");
  await once(child, "message");
  assert(child.pid);
  try {
    await withOwner(async (fence) => {
      const store = createManagedHandoffLeaseStore();
      const acquired = store.acquire(`${root}/.openclaw-update-child-extra`, "extra-child", {
        kind: "update",
      });
      assert(acquired.kind === "acquired");
      const registered = store.bind(acquired.lease, child.pid!);
      assert(registered);
      expectReleaseRefused(fence, "release failed");
      expect(() => fence.assertCurrent()).toThrow("no longer current");
      expectReleaseRefused(fence);
      expectReleased(serviceRoot);
      expectBusy(root);
      expect(store.current(registered)).toBe(true);
      child.kill("SIGTERM");
      await exited;
      expect(store.release(registered)).toBe(true);
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await exited;
  }
  expectReleased(root);
});

it("preserves eligible preflight release until a healthy auxiliary descendant drain joins", async ({
  signal,
}) => {
  const ready = path.join(root, "draining");
  const proceed = path.join(root, "finish-drain");
  const descendant = `${fixtureReceiptClientSource(receipts.channel.endpoint)}
  import fs from 'node:fs';process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(ready)},'draining');sendReceipt(${JSON.stringify(ready)},"ready");const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(proceed)})){clearInterval(timer);process.exit(0)}},10)});setInterval(()=>{},1000);process.send('ready');`;
  const program = `const child=require('node:child_process').spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>{child.disconnect();child.unref()});`;
  await withOwner(async (fence) => {
    const pending = withUpdateCommandExecutorChild(
      fence,
      root,
      (grant, beforeInput) => runBoundChild(grant, beforeInput, program, 5000),
      { auxiliaryPreflight: true },
    );
    try {
      await withinTest(receipts.ready(ready, pending), signal);
      expectReleaseRefused(fence, "The update process is still running.");
      expectBusy(root);
    } finally {
      fs.writeFileSync(proceed, "continue");
    }
    expect(await pending).toMatchObject({ code: 0, cleanup: "cooperative" });
    releaseUpdateCommandPreflightForHandoff(fence);
  });
});

it.each(["empty", "extra", "malformed", "invalid-entry", "invalid-utf8", "nul"] as const)(
  "never starts Node provisioning without released authorization input: %s",
  async (frame) => {
    const effect = path.join(root, "installer-effect");
    const drained = path.join(root, "gate-drained");
    const preload = preloadFixture("require");
    if (frame === "nul") {
      preload.env.NODE_OPTIONS += "\0private-option";
    }
    const runCommand = processRunner.runCommandWithTimeout;
    let observed: Awaited<ReturnType<typeof runCommand>> | undefined;
    vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation((argv, options) => {
      assert(typeof options !== "number" && typeof options.input === "string");
      // Corrupt only the private input, retaining real admission, process custody and payload.
      let input: string | Uint8Array = options.input;
      if (frame === "invalid-utf8") {
        const bytes = Buffer.from(input);
        const index = bytes.indexOf(Buffer.from("é"));
        assert(index >= 0);
        bytes[index] = 0xff;
        input = bytes;
      } else {
        input = {
          empty: "",
          extra: input + " ",
          malformed: "{" + input.slice(1),
          "invalid-entry": input.replace("NODE_OPTIONS", "_ODE_OPTIONS"),
          nul: input,
        }[frame];
      }
      if (["malformed", "invalid-entry", "invalid-utf8"].includes(frame)) {
        expect(Buffer.byteLength(input)).toBe(Buffer.byteLength(options.input));
      }
      const cleanup = path.join(root, "observe-gate-exit.cjs");
      fs.writeFileSync(
        cleanup,
        `process.once("beforeExit", () => require("node:fs").writeFileSync(${JSON.stringify(drained)}, "settled"));`,
      );
      return runCommand([argv[0]!, "--require", cleanup, ...argv.slice(1)], {
        ...options,
        input,
      }).then((result) => {
        observed = result;
        return result;
      });
    });
    await expect(
      withOwner(async () => installer()(nodeExecPath, effectArgs(effect), preload.env)),
    ).rejects.toThrow("did not complete");
    expect([effect, preload.marker].map(fs.existsSync)).toEqual([false, false]);
    expect(observed).toMatchObject({ code: 1, stdout: "", stderr: "" });
    expect(fs.readFileSync(drained, "utf8")).toBe("settled");
    expectReleased();
  },
);

it.each([undefined, ""])("preserves absent or empty native payload options: %s", async (value) => {
  const effect = path.join(root, "native-options");
  const gate = prepareUpdateCommandNativeGate(randomUUID(), [
    { ...process.env, NODE_OPTIONS: value },
  ]);
  const result = await runUtf8CommandWithTimeout(
    [
      ...gate.argv,
      nodeExecPath,
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(effect)},JSON.stringify(process.env.NODE_OPTIONS ?? null));`,
    ],
    {
      baseEnv: {},
      env: gate.env,
      input: gate.input,
      timeoutMs: 10000,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
    },
  );
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(fs.readFileSync(effect, "utf8"))).toBe(value ?? null);
});

it.skipIf(process.platform === "win32").each([false, true])(
  "keeps retained native preloads behind admission, released=%s",
  async (released) => {
    const preload = preloadFixture("require");
    const effect = path.join(root, "native-effect");
    const runCommand = processRunner.runCommandWithTimeout;
    if (!released) {
      vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation((argv, options) => {
        assert(typeof options !== "number");
        return runCommand(argv, { ...options, input: "" });
      });
    }
    await withOwner(async () => {
      await withRetainedUpdateServiceAuthority(
        {
          run,
          root: serviceRoot,
          assertCurrent: () => {},
        },
        async () => {
          // Exercise the supplied native seam; ordinary service-manager env projection stays intact.
          const native = getGatewayServiceUpdateNativeCommand();
          assert(native);
          const result = await native(
            [nodeExecPath, ...effectArgs(effect, "String(process.pid)")],
            { baseEnv: preload.env, env: { NODE_NO_WARNINGS: "1" }, timeoutMs: 10000 },
          );
          expect(result).toMatchObject({ code: released ? 0 : 1, stderr: "" });
        },
      );
    }, false);
    expect([effect, preload.marker].map(fs.existsSync)).toEqual([released, released]);
    if (released) {
      expect(fs.readFileSync(preload.marker, "utf8")).toBe(`${fs.readFileSync(effect, "utf8")}\n`);
    }
    expectReleased();
  },
);

it.each([
  {
    platform: "linux",
    sources: [{ NODE_OPTIONS: "private", node_options: "case-distinct", KEEP: "yes" }],
    env: { node_options: "case-distinct", KEEP: "yes" },
    entry: ["NODE_OPTIONS", "private"],
  },
  {
    platform: "win32",
    sources: [{ NODE_OPTIONS: "base", KEEP: "yes" }, { node_options: "override" }],
    env: { KEEP: "yes" },
    entry: ["node_options", "override"],
  },
  {
    platform: "win32",
    sources: [{ node_options: "later", NODE_OPTIONS: undefined, KEEP: "yes" }],
    env: { KEEP: "yes" },
    entry: null,
  },
] as const)(
  "preserves native-gate environment precedence on $platform",
  ({ platform, sources, env, entry }) => {
    const before = structuredClone(sources);
    const ticket = randomUUID();
    const gate = prepareUpdateCommandNativeGate(ticket, sources, platform);
    expect(gate.env).toEqual(env);
    expect(JSON.parse(gate.input)).toEqual([ticket, entry]);
    expect(gate.argv.join(" ")).not.toContain("private");
    expect(sources).toEqual(before);
  },
);

it.each(["before-launch", "at-input"] as const)(
  "refuses Node provisioning after requester revocation at %s",
  async (boundary) => {
    const effect = path.join(root, "installer-effect");
    let requesterCurrent = true;
    const revoke = () => {
      requesterCurrent = false;
    };
    const runCommand = processRunner.runCommandWithTimeout;
    const commands = vi
      .spyOn(processRunner, "runCommandWithTimeout")
      .mockImplementation((argv, options) => {
        assert(typeof options !== "number");
        return runCommand(argv, {
          ...options,
          beforeInput: (pid, spawnedArgv) => {
            if (boundary === "at-input") {
              revoke();
            }
            options.beforeInput?.(pid, spawnedArgv);
          },
        });
      });
    const work = withOwner(async () => {
      run.requesterAuthority = { requester: {}, isCurrent: () => requesterCurrent };
      const install = installer();
      if (boundary === "before-launch") {
        revoke();
      }
      await install(nodeExecPath, effectArgs(effect), process.env);
    });
    await expect(work).rejects.toThrow("requester-revoked");
    expect(commands).toHaveBeenCalledTimes(boundary === "at-input" ? 1 : 0);
    expect(fs.existsSync(effect)).toBe(false);
    expectReleased();
  },
);
