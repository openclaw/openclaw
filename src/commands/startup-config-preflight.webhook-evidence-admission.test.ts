// Startup must wait for a transient schema lease taken after the webhook completion read.
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { stateNativeProcessEntrypoints } from "../state/native-process-runtime.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

const hook = vi.hoisted(() => ({
  afterCompletionRead: undefined as undefined | (() => Promise<void>),
  onPendingAdmission: undefined as undefined | (() => void),
}));
vi.mock("./doctor/shared/legacy-webhook-pins.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./doctor/shared/legacy-webhook-pins.js")>();
  return {
    ...original,
    readWebhookCompletion: async (...args: Parameters<typeof original.readWebhookCompletion>) => {
      const result = await original.readWebhookCompletion(...args);
      await hook.afterCompletionRead?.();
      return result;
    },
  };
});
vi.mock("../infra/gateway-state-owner-record.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../infra/gateway-state-owner-record.js")>();
  return {
    ...original,
    assertPersistedStateDatabaseAccessAllowed: (
      ...args: Parameters<typeof original.assertPersistedStateDatabaseAccessAllowed>
    ) => {
      try {
        original.assertPersistedStateDatabaseAccessAllowed(...args);
      } catch (error) {
        if (error instanceof original.StateDatabaseAdmissionPendingError) {
          // Startup met the held lease; only now may the foreign holder finish.
          hook.onPendingAdmission?.();
        }
        throw error;
      }
    },
  };
});

/** Hold state custody from another process until `releasePath` exists or `signal` aborts. */
function startForeignStateOwner(params: {
  databasePath: string;
  holder: "schema-lease" | "offline-maintenance";
  releasePath: string;
  signal: AbortSignal;
}) {
  const ownerUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.gatewayStateOwner);
  // A schema lease is the transient custody any state CLI takes (e.g. `gateway status`).
  // The process root is the record Doctor's maintenance lock persists.
  const acquire =
    params.holder === "schema-lease"
      ? `acquireStateDatabaseSchemaLease(${JSON.stringify(params.databasePath)})`
      : `acquireGatewayStateOwner({ databasePath: ${JSON.stringify(params.databasePath)} })`;
  let readOutput = () => ({ stdout: "", stderr: "" });
  const exited = runNodeScript(
    (workerArgv) => [
      ...workerArgv(ownerUrl).slice(0, -1),
      "--input-type=module",
      "--eval",
      `import fs from "node:fs";
      const owner = await import(${JSON.stringify(ownerUrl.href)});
      const held = owner.${acquire};
      process.stdout.write("held\\n");
      const poll = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(params.releasePath)})) {
          clearInterval(poll);
          held.release();
        }
      }, 10);`,
    ],
    process.env,
    30_000,
    {
      signal: params.signal,
      onReady(_child, read) {
        readOutput = read;
      },
    },
  ).catch(() => undefined);
  const ready = (async () => {
    const deadline = performance.now() + 20_000;
    while (!readOutput().stdout.includes("held")) {
      if (performance.now() > deadline) {
        throw new Error(`Foreign state owner never held custody: ${readOutput().stderr}`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  })();
  return { exited, ready };
}

it.each(["schema-lease", "offline-maintenance"] as const)(
  "handles a foreign %s acquired after the webhook completion read",
  async (holder) => {
    await withOpenClawTestState({ label: "gateway-after-webhook-read" }, async (state) => {
      await state.writeConfig({ gateway: { mode: "local" }, plugins: { enabled: false } });
      const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
      await closeOpenClawStateDatabaseAsync();
      const releasePath = path.join(path.dirname(databasePath), "foreign-owner.release");
      const stop = new AbortController();
      let foreignOwner: Promise<unknown> | undefined;
      let pendingAdmissions = 0;
      hook.afterCompletionRead = async () => {
        hook.afterCompletionRead = undefined;
        const owner = startForeignStateOwner({
          databasePath,
          holder,
          releasePath,
          signal: stop.signal,
        });
        foreignOwner = owner.exited;
        await owner.ready;
      };
      hook.onPendingAdmission = () => {
        pendingAdmissions += 1;
        fs.writeFileSync(releasePath, "");
      };
      try {
        const ready = runStartupConfigPreflight({ gateway: true, observe: false });
        if (holder === "schema-lease") {
          await expect(ready).resolves.toMatchObject({ snapshot: { valid: true } });
          expect(pendingAdmissions).toBeGreaterThan(0);
        } else {
          await expect(ready).rejects.toThrow("offline maintenance");
        }
        expect(foreignOwner).toBeDefined();
      } finally {
        hook.afterCompletionRead = undefined;
        hook.onPendingAdmission = undefined;
        stop.abort();
        await foreignOwner;
        await closeOpenClawStateDatabaseAsync();
      }
    });
  },
);
