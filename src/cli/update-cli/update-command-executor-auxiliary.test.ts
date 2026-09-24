import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { getGatewayServiceUpdateNativeCommand } from "../../daemon/service-update-authority.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import * as processRunner from "../../process/exec.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
import { prepareUpdateCommandNativeGate } from "./update-command-native-gate.js";
import { createPackageRuntimeRecovery } from "./update-command-node-runtime.js";
import { withRetainedUpdateServiceAuthority } from "./update-command-retained-service.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let serviceRoot: string;
beforeEach(() => {
  const base = fs.realpathSync(dirs.make("auxiliary-node-owner-"));
  root = path.join(base, "package-B");
  serviceRoot = path.join(base, "service-A");
  const control = path.join(base, "control");
  for (const directory of [root, serviceRoot, control]) {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
});
afterEach(() => vi.restoreAllMocks());

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

it.each([
  { phase: "admitted", fragmented: false },
  { phase: "initializing", fragmented: false },
  { phase: "admitted", fragmented: true },
] as const)(
  "preserves direct preflight release through a healthy installer child and active drain: $phase/fragmented=$fragmented",
  async ({ phase, fragmented }) => {
    const runId = randomUUID();
    const ready = path.join(root, "ready");
    const proceed = path.join(root, "proceed");
    const preload = preloadFixture(phase === "admitted" ? "require" : "import");
    if (fragmented) {
      const runCommand = processRunner.runCommandWithTimeout;
      vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation((argv, options) => {
        assert(typeof options !== "number" && typeof options.input === "string");
        expect(Buffer.byteLength(options.input)).toBeGreaterThan(options.input.length);
        // Split the private frame deterministically; OS pipe writes may coalesce UTF-8 fragments.
        const receiver = `
          const inputParts = [];
          for await (const part of process.stdin) inputParts.push(part);
          const { Readable } = await import("node:stream");
          Object.defineProperty(process, "stdin", { value: Readable.from(
            [...Buffer.concat(inputParts)].map(byte => Buffer.from([byte]))
          ) });
        `;
        return runCommand([...argv.slice(0, 3), receiver + argv[3], ...argv.slice(4)], options);
      });
    }
    await withUpdateCommandExecutor(runId, async (executor) => {
      const fence = await executor.enter(root, { serviceRoot, preflight: true });
      const recovery = createPackageRuntimeRecovery({
        root,
        opts:
          phase === "admitted" ? { run: { runId, env: process.env, executorFence: fence } } : {},
        executorFence: phase === "initializing" ? fence : undefined,
        timeoutMs: 10000,
      });
      assert(recovery.installCommand);
      const installing = recovery.installCommand(
        process.execPath,
        [
          "-e",
          `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,nodeOptions:process.env.NODE_OPTIONS}));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(proceed)})){clearInterval(timer)}},10);`,
        ],
        preload.env,
      );
      try {
        await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true), { timeout: 5000 });
        expect(() => releaseUpdateCommandPreflightForHandoff(fence)).toThrow(
          "The update process is still running.",
        );
        await expect(executor.enter(root, { serviceRoot })).rejects.toThrow(
          "The update process is still running.",
        );
        for (const key of [root, serviceRoot]) {
          expect(
            createManagedHandoffLeaseStore().acquire(key, "contender", { kind: "update" }).kind,
          ).toBe("busy");
        }
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
    expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
    expect(createManagedHandoffLeaseStore().read(serviceRoot)).toEqual({ kind: "absent" });
  },
);

it.each(["nonzero", "timeout", "unsettled", "operation", "candidate-busy"] as const)(
  "caught auxiliary failure never restores handoff eligibility: %s",
  async (failure) => {
    const runId = randomUUID();
    const work = withUpdateCommandExecutor(runId, async (executor) => {
      const fence = await executor.enter(root, { serviceRoot, preflight: true });
      if (failure === "nonzero" || failure === "timeout" || failure === "unsettled") {
        const recovery = createPackageRuntimeRecovery({
          root,
          opts: { run: { runId, env: process.env, executorFence: fence } },
          timeoutMs: failure === "timeout" ? 150 : 10000,
        });
        assert(recovery.installCommand);
        const childCode =
          "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready')";
        const unsettled = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>{child.disconnect();child.unref()});`;
        await expect(
          recovery.installCommand(
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
              async (_grant, beforeInput) => {
                await runUtf8CommandWithTimeout(
                  [process.execPath, "-e", "require('node:fs').readFileSync(0,'utf8')"],
                  {
                    input: "",
                    beforeInput,
                    timeoutMs: 10000,
                    killProcessTree: true,
                    requireProcessTreeExtinction: true,
                  },
                );
                throw new Error("fixture operation failed");
              },
              { auxiliaryPreflight: true },
            ),
          ).rejects.toThrow();
        } finally {
          if (incumbent?.kind === "acquired") {
            expect(store.current(incumbent.lease)).toBe(true);
            expect(store.release(incumbent.lease)).toBe(true);
          }
        }
      }
      expect(() => releaseUpdateCommandPreflightForHandoff(fence)).toThrow("not current");
      // A later healthy auxiliary call may not re-arm the deleted entry.
      await withUpdateCommandExecutorChild(
        fence,
        root,
        (_grant, beforeInput) =>
          runUtf8CommandWithTimeout(
            [process.execPath, "-e", "require('node:fs').readFileSync(0,'utf8')"],
            {
              input: "",
              beforeInput,
              timeoutMs: 10000,
              killProcessTree: true,
              requireProcessTreeExtinction: true,
            },
          ),
        { auxiliaryPreflight: true },
      );
      expect(() => releaseUpdateCommandPreflightForHandoff(fence)).toThrow("not current");
    });
    // The original child failure remains sticky even if the caller catches it.
    await expect(work).rejects.toThrow();
  },
);

it.each(["ordinary", "promote-before", "promote-after"] as const)(
  "does not re-arm a non-preflight owner after %s",
  async (scenario) => {
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root, { serviceRoot, preflight: true });
      if (scenario === "promote-before") {
        await executor.enter(root, { serviceRoot });
      }
      await withUpdateCommandExecutorChild(
        fence,
        root,
        (_grant, beforeInput) =>
          runUtf8CommandWithTimeout(
            [process.execPath, "-e", "require('node:fs').readFileSync(0,'utf8')"],
            {
              input: "",
              beforeInput,
              timeoutMs: 10000,
              killProcessTree: true,
              requireProcessTreeExtinction: true,
            },
          ),
        scenario === "ordinary" ? undefined : { auxiliaryPreflight: true },
      );
      if (scenario === "promote-after") {
        await executor.enter(root, { serviceRoot });
      }
      expect(() => releaseUpdateCommandPreflightForHandoff(fence)).toThrow("not current");
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
    await expect(
      withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(root, { serviceRoot, preflight: true });
        const store = createManagedHandoffLeaseStore();
        const acquired = store.acquire(`${root}/.openclaw-update-child-extra`, "extra-child", {
          kind: "update",
        });
        assert(acquired.kind === "acquired");
        const registered = store.bind(acquired.lease, child.pid!);
        assert(registered);
        expect(() => releaseUpdateCommandPreflightForHandoff(fence)).toThrow("release failed");
        expect(() => fence.assertCurrent()).toThrow("no longer current");
        expect(() => releaseUpdateCommandPreflightForHandoff(fence)).toThrow("not current");
        expect(store.read(serviceRoot)).toEqual({ kind: "absent" });
        expect(store.acquire(root, "contender", { kind: "update" }).kind).toBe("busy");
        expect(store.current(registered)).toBe(true);
        child.kill("SIGTERM");
        await exited;
        expect(store.release(registered)).toBe(true);
      }),
    ).rejects.toThrow();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await exited;
  }
  expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
});

it("preserves eligible preflight release until a healthy auxiliary descendant drain joins", async () => {
  const ready = path.join(root, "draining");
  const proceed = path.join(root, "finish-drain");
  const descendant = `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(ready)},'draining');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(proceed)})){clearInterval(timer);process.exit(0)}},10)});setInterval(()=>{},1000);process.send('ready');`;
  const program = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>{child.disconnect();child.unref()});`;
  await withUpdateCommandExecutor(randomUUID(), async (executor) => {
    const fence = await executor.enter(root, { serviceRoot, preflight: true });
    const pending = withUpdateCommandExecutorChild(
      fence,
      root,
      (_grant, beforeInput) =>
        runUtf8CommandWithTimeout([process.execPath, "-e", program], {
          input: "",
          beforeInput,
          timeoutMs: 10000,
          killGraceMs: 5000,
          killProcessTree: true,
          requireProcessTreeExtinction: true,
        }),
      { auxiliaryPreflight: true },
    );
    try {
      await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true), { timeout: 5000 });
      expect(() => releaseUpdateCommandPreflightForHandoff(fence)).toThrow(
        "The update process is still running.",
      );
      expect(
        createManagedHandoffLeaseStore().acquire(root, "contender", { kind: "update" }).kind,
      ).toBe("busy");
    } finally {
      fs.writeFileSync(proceed, "continue");
    }
    expect(await pending).toMatchObject({ code: 0, cleanup: "cooperative" });
    releaseUpdateCommandPreflightForHandoff(fence);
  });
});

it.each([
  { kind: "require", frame: "empty" },
  { kind: "import", frame: "empty" },
  { kind: "require", frame: "truncated" },
  { kind: "require", frame: "extra" },
  { kind: "require", frame: "malformed" },
  { kind: "require", frame: "invalid-entry" },
  { kind: "require", frame: "invalid-utf8" },
  { kind: "require", frame: "nul" },
] as const)(
  "never starts Node provisioning without released authorization input: $kind/$frame",
  async ({ kind, frame }) => {
    const runId = randomUUID();
    const effect = path.join(root, "installer-effect");
    const preload = preloadFixture(kind);
    if (frame === "nul") {
      preload.env.NODE_OPTIONS += "\0private-option";
    }
    const runCommand = processRunner.runCommandWithTimeout;
    let observed: Awaited<ReturnType<typeof runCommand>> | undefined;
    vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation((argv, options) => {
      assert(typeof options !== "number");
      assert(typeof options.input === "string");
      // Corrupt only the private input, retaining real admission, process custody and payload.
      let input: string | Uint8Array = options.input;
      if (frame === "empty") {
        input = "";
      }
      if (frame === "truncated") {
        input = input.slice(0, -1);
      }
      if (frame === "extra") {
        input += " ";
      }
      if (frame === "malformed") {
        input = "{" + input.slice(1);
      }
      if (frame === "invalid-entry") {
        input = input.replace("NODE_OPTIONS", "_ODE_OPTIONS");
      }
      if (frame === "invalid-utf8") {
        const bytes = Buffer.from(input);
        const index = bytes.indexOf(Buffer.from("é"));
        assert(index >= 0);
        bytes[index] = 0xff;
        input = bytes;
      }
      if (["malformed", "invalid-entry", "invalid-utf8"].includes(frame)) {
        expect(Buffer.byteLength(input)).toBe(Buffer.byteLength(options.input));
      }
      return runCommand(argv, { ...options, input }).then((result) => {
        observed = result;
        return result;
      });
    });
    const outcome = await withUpdateCommandExecutor(runId, async (executor) => {
      const fence = await executor.enter(root, { serviceRoot, preflight: true });
      const recovery = createPackageRuntimeRecovery({
        root,
        opts: { run: { runId, env: process.env, executorFence: fence } },
        timeoutMs: 10000,
      });
      assert(recovery.installCommand);
      await recovery.installCommand(
        process.execPath,
        ["-e", `require('node:fs').writeFileSync(${JSON.stringify(effect)},'unauthorized')`],
        preload.env,
      );
    }).then(
      () => "installed",
      () => "refused",
    );
    expect(fs.existsSync(effect)).toBe(false);
    expect(fs.existsSync(preload.marker)).toBe(false);
    expect(observed).toMatchObject({ code: 1, stdout: "", stderr: "" });
    expect(outcome).toBe("refused");
    for (const key of [root, serviceRoot]) {
      expect(createManagedHandoffLeaseStore().read(key)).toEqual({ kind: "absent" });
    }
  },
);

it.each([undefined, ""])("preserves absent or empty native payload options: %s", async (value) => {
  const effect = path.join(root, "native-options");
  const gate = prepareUpdateCommandNativeGate(randomUUID(), [
    { ...process.env, NODE_OPTIONS: value },
  ]);
  const result = await runUtf8CommandWithTimeout(
    [
      process.execPath,
      "--input-type=module",
      "-e",
      gate.source,
      "--",
      process.execPath,
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
    const runId = randomUUID();
    await withUpdateCommandExecutor(runId, async (executor) => {
      const fence = await executor.enter(root, { serviceRoot });
      await withRetainedUpdateServiceAuthority(
        {
          run: { runId, env: process.env, executorFence: fence },
          root: serviceRoot,
          assertCurrent: () => {},
        },
        async () => {
          // Exercise the supplied native seam; ordinary service-manager env projection stays intact.
          const native = getGatewayServiceUpdateNativeCommand();
          assert(native);
          const result = await native(
            [
              process.execPath,
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(effect)},String(process.pid));`,
            ],
            { baseEnv: preload.env, env: { NODE_NO_WARNINGS: "1" }, timeoutMs: 10000 },
          );
          expect(result.code).toBe(released ? 0 : 1);
          expect(result.stderr).toBe("");
        },
      );
    });
    expect(fs.existsSync(effect)).toBe(released);
    expect(fs.existsSync(preload.marker)).toBe(released);
    if (released) {
      expect(fs.readFileSync(preload.marker, "utf8")).toBe(`${fs.readFileSync(effect, "utf8")}\n`);
    }
    for (const key of [root, serviceRoot]) {
      expect(createManagedHandoffLeaseStore().read(key)).toEqual({ kind: "absent" });
    }
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
    expect(gate.source).not.toContain("private");
    expect(sources).toEqual(before);
  },
);

it.each(
  (["before-launch", "at-input"] as const).flatMap((boundary) =>
    (
      [
        "options-replaced",
        "run-replaced",
        "run-id-changed",
        "executor-replaced",
        "requester-replaced",
        "requester-revoked",
      ] as const
    ).map((change) => ({ boundary, change })),
  ),
)("refuses Node provisioning after $change at $boundary", async ({ boundary, change }) => {
  const runId = randomUUID();
  const effect = path.join(root, "installer-effect");
  let requesterCurrent = true;
  const opts: UpdateCommandOptions = {
    run: {
      runId,
      env: process.env,
      requesterAuthority: { requester: {}, isCurrent: () => requesterCurrent },
    },
  };
  const recoveryParams = { root, opts, timeoutMs: 10000 };
  const revoke = () => {
    assert(opts.run);
    if (change === "options-replaced") {
      recoveryParams.opts = { run: { ...opts.run } };
    }
    if (change === "run-replaced") {
      opts.run = { ...opts.run };
    }
    if (change === "run-id-changed") {
      opts.run.runId = randomUUID();
    }
    if (change === "executor-replaced") {
      opts.run.executorFence = { assertCurrent() {} };
    }
    if (change === "requester-replaced") {
      opts.run.requesterAuthority = { requester: {}, isCurrent: () => true };
    }
    if (change === "requester-revoked") {
      requesterCurrent = false;
    }
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
  const work = withUpdateCommandExecutor(runId, async (executor) => {
    assert(opts.run);
    opts.run.executorFence = await executor.enter(root, { serviceRoot, preflight: true });
    const recovery = createPackageRuntimeRecovery(recoveryParams);
    assert(recovery.installCommand);
    if (boundary === "before-launch") {
      revoke();
    }
    await recovery.installCommand(
      process.execPath,
      ["-e", `require('node:fs').writeFileSync(${JSON.stringify(effect)},'unauthorized')`],
      process.env,
    );
  });
  await expect(work).rejects.toThrow(
    change === "requester-revoked" ? "requester-revoked" : "lost its original update executor",
  );
  expect(commands).toHaveBeenCalledTimes(boundary === "at-input" ? 1 : 0);
  expect(fs.existsSync(effect)).toBe(false);
  for (const key of [root, serviceRoot]) {
    expect(createManagedHandoffLeaseStore().read(key)).toEqual({ kind: "absent" });
  }
});
