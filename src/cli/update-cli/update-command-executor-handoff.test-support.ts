import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveServiceManagerEnv } from "../../daemon/service-process-env.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
} from "../../infra/update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { MANAGED_HANDOFF_RUNTIME_ENTRY } from "../../infra/update-managed-service-handoff-runtime-assets.js";
import { stageManagedHandoffRuntime } from "../../infra/update-managed-service-handoff-runtime.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import {
  captureUpdateCommandExecutorAuthority,
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";

// The installed parent prepares the database before a sealed actor can acquire a lease.
export function prepareStagedLeaseFixture(root: string, temporary: string) {
  const databasePath = path.join(temporary, "managed-update-handoffs.sqlite");
  const existingIdentity = createManagedHandoffLeaseDatabase(databasePath)(true, () =>
    captureManagedUpdateLeaseDatabaseIdentity(databasePath),
  );
  stageManagedHandoffRuntime(root);
  return {
    runtimeEntry: path.join(root, "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY),
    options: { databasePath, serviceManagerEnv: resolveServiceManagerEnv(), existingIdentity },
  };
}

export function registerExecutorHelperHandoffTests(
  fixture: () => {
    root: string;
    prepareStagedLeaseFixture: () => {
      runtimeEntry: string;
      options: Parameters<typeof createManagedHandoffLeaseStore>[0];
    };
  },
) {
  it.each([false, true])(
    "borrows the exact helper package owner with a separate service root: %s",
    async (splitRoot) => {
      const { root, prepareStagedLeaseFixture: prepareLease } = fixture();
      const { runtimeEntry, options } = prepareLease();
      const runId = randomUUID();
      const owner = randomUUID();
      const metadata = path.join(root, "handoff.json");
      fs.writeFileSync(
        metadata,
        JSON.stringify({ version: 1, meta: { runId, handoffId: owner, root } }),
      );
      vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "1");
      vi.stubEnv(CONTROL_PLANE_UPDATE_SENTINEL_META_ENV, metadata);
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
      const {createManagedHandoffLeaseStore}=require(${JSON.stringify(runtimeEntry)});
      const store=createManagedHandoffLeaseStore(${JSON.stringify(options)});
      const acquired=store.acquire(${JSON.stringify(root)},${JSON.stringify(owner)},{kind:"update"});
      if(acquired.kind!=="acquired")throw new Error("helper admission failed");
      const assigned=store.bind(acquired.lease,${process.pid});
      if(!assigned)throw new Error("helper assignment failed");
      process.once("message",()=>{
        const local=store.bind(assigned,process.pid);
        if(!local||!store.release(local))throw new Error("helper release failed");
        process.disconnect();
      });
      process.send("assigned");
    `,
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      const exited = once(child, "exit");
      let stderr = "";
      child.stderr?.on("data", (data) => {
        stderr += String(data);
      });
      try {
        const ready = await Promise.race([
          once(child, "message").then(([message]) => message),
          exited.then(() => {
            throw new Error(`helper exited before assignment: ${stderr}`);
          }),
        ]);
        expect(ready).toBe("assigned");
        const store = createManagedHandoffLeaseStore();
        const serviceRoot = splitRoot ? path.join(root, "service-A") : undefined;
        if (serviceRoot) {
          fs.mkdirSync(serviceRoot);
        }
        await withUpdateCommandExecutor(runId, async (executor) => {
          const fence = await executor.enter(root, { serviceRoot, preflight: true });
          expect(captureUpdateCommandExecutorAuthority(fence).installKey).toBe(root);
          if (serviceRoot) {
            expect(store.read(serviceRoot).kind).toBe("current");
          }
          expect(() => releaseUpdateCommandPreflightForHandoff(fence)).toThrow("not current");
          const result = await withUpdateCommandExecutorChild(
            fence,
            root,
            (grant, beforeInput) =>
              runUtf8CommandWithTimeout(
                [
                  process.execPath,
                  "--input-type=module",
                  "-e",
                  `import {json} from "node:stream/consumers";
               import {withDelegatedUpdateCommandExecutor,captureUpdateCommandExecutorAuthority} from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.executor).href)};
               const grant=await json(process.stdin);
               let inventoried=false;
               await withDelegatedUpdateCommandExecutor(grant,grant.runId,grant.root,async(fence)=>{
                 if(!inventoried)throw new Error("inventory was not admitted");
                 fence.assertCurrent(); process.stdout.write(JSON.stringify(captureUpdateCommandExecutorAuthority(fence)));
               },{activationTimeoutMs:async(fence)=>{
                 captureUpdateCommandExecutorAuthority(fence);
                 await Promise.resolve(); inventoried=true; return undefined;
               }});`,
                ],
                {
                  input: JSON.stringify(grant),
                  beforeInput,
                  timeoutMs: 15_000,
                  killProcessTree: true,
                  requireProcessTreeExtinction: true,
                },
              ),
            { auxiliaryPreflight: true },
          );
          expect(result.code, result.stderr).toBe(0);
          expect(JSON.parse(result.stdout)).toEqual(captureUpdateCommandExecutorAuthority(fence));
          expect(() => releaseUpdateCommandPreflightForHandoff(fence)).toThrow("not current");
          fence.assertCurrent();
        });
        if (serviceRoot) {
          expect(store.read(serviceRoot)).toEqual({ kind: "absent" });
        }
        const current = store.read(root);
        expect(current.kind === "current" && current.lease.owner).toBe(owner);
        await expect(
          withUpdateCommandExecutor(randomUUID(), async (executor) => executor.enter(root)),
        ).rejects.toThrow("changed during admission");
        expect(store.read(root)).toEqual(current);
      } finally {
        if (child.connected) {
          child.send("release");
        }
        const [code] = await exited;
        expect(code, stderr).toBe(0);
      }
      expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
    },
  );
}
