import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import {
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
import { createPackageRuntimeRecovery } from "./update-command-node-runtime.js";

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

it.each(["admitted", "initializing"] as const)(
  "preserves direct preflight release through a healthy installer child and active drain: %s",
  async (phase) => {
    const runId = randomUUID();
    const ready = path.join(root, "ready");
    const proceed = path.join(root, "proceed");
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
          `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(proceed)})){clearInterval(timer)}},10);`,
        ],
        process.env,
      );
      try {
        await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true), { timeout: 5000 });
        expect(() => releaseUpdateCommandPreflightForHandoff(fence)).toThrow("suspended");
        await expect(executor.enter(root, { serviceRoot })).rejects.toThrow("suspended");
        for (const key of [root, serviceRoot]) {
          expect(
            createManagedHandoffLeaseStore().acquire(key, "contender", { kind: "update" }).kind,
          ).toBe("busy");
        }
      } finally {
        fs.writeFileSync(proceed, "continue");
      }
      expect(await installing).toBe(0);
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
      expect(() => releaseUpdateCommandPreflightForHandoff(fence)).toThrow("suspended");
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
