import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { cliCleanupRetirementEntrypoints } from "./cli-entrypoint.test-support.js";
import { formatCliProcessFailure, runCliProcessChild } from "./cli-process-child.test-helpers.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const entries = Object.fromEntries(
  Object.entries(cliCleanupRetirementEntrypoints).map(([name, entry]) => [
    name,
    resolveRuntimeWorkerUrl(entry).href,
  ]),
);

it.each(["success", "failure"])(
  "drains executable resources after source replacement without changing %s",
  async (outcome) => {
    const directory = directories.make("openclaw-cli-cleanup-retirement-");
    const nodeExecutable = resolveTestNodeExecPath();
    const result = await runCliProcessChild({
      nodeExecutable,
      nodeArgs: [
        ...resolveRuntimeWorkerArgv(new URL(entries.scope!), nodeExecutable).slice(0, -1),
        "--input-type=module",
        "--eval",
        String.raw`
          import assert from "node:assert/strict";
          import { copyFileSync, unlinkSync } from "node:fs";
          import { once } from "node:events";
          import { registerHooks } from "node:module";
          import { join } from "node:path";
          import { pathToFileURL } from "node:url";

          const entries = ${JSON.stringify(entries)};
          const copies = new Map(Object.entries(entries).map(([name, source]) => [
            source, pathToFileURL(join(${JSON.stringify(directory)}, name + ".mjs")).href,
          ]));
          const originals = new Map([...copies].map(([source, copy]) => [copy, source]));
          for (const [source, copy] of copies) copyFileSync(new URL(source), new URL(copy));
          // Only the four copied modules move. Their other imports retain the prepared
          // graph; the real Node resolver still checks whether each copy exists.
          const hooks = registerHooks({
            resolve(specifier, context, nextResolve) {
              const parentURL = originals.get(context.parentURL) ?? context.parentURL;
              const requested = specifier.startsWith(".")
                ? new URL(specifier, parentURL).href : specifier;
              return nextResolve(copies.get(requested) ?? specifier, { ...context, parentURL });
            },
          });
          const { withCliProcessScope, withCliCommandCleanup } = await import(entries.scope);
          // The ordinary entry loads cleanup elsewhere first; this does not prime
          // the cleanup scope's distinct resolution after its files disappear.
          const { waitForPendingCliDisposers } = await import(entries.cleanup);
          const { registerOpenClawStateDatabaseAsyncResource } = await import(entries.database);
          const { createRetainedNativeWorker, closeDefaultRetainedNativeWorkerSource } =
            await import(entries.workers);
          const supervisors = [];
          const captureWorker = worker => supervisors.push(worker);
          process.on("worker", captureWorker);
          const worker = createRetainedNativeWorker(
            'const {parentPort} = require("node:worker_threads"); parentPort.on("message", () => {}); parentPort.postMessage("ready");',
            { eval: true, env: {} },
          );
          await once(worker, "message");
          assert(supervisors.length > 0);
          assert(supervisors.every(worker => worker.threadId !== -1));
          let closed = false;
          const unregister = registerOpenClawStateDatabaseAsyncResource({
            async close() { await worker.terminate(); closed = true; unregister(); },
          });
          const commandError = new Error("synthetic command failure");
          try {
            const command = withCliProcessScope(() => withCliCommandCleanup(false, async cleanup => {
              await cleanup.pluginResources.release();
              for (const copy of copies.values()) unlinkSync(new URL(copy));
              if (${JSON.stringify(outcome)} === "failure") throw commandError;
              return "command-result";
            }));
            if (${JSON.stringify(outcome)} === "failure") {
              await assert.rejects(command, error => error === commandError);
            } else {
              assert.equal(await command, "command-result");
            }
            await waitForPendingCliDisposers();
            assert.equal(closed, true);
            assert(supervisors.every(worker => worker.threadId === -1));
            console.log("cleanup joined after source retirement");
          } finally {
            await worker.terminate();
            unregister();
            await closeDefaultRetainedNativeWorkerSource();
            process.off("worker", captureWorker);
            hooks.deregister();
          }
        `,
      ],
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        OPENCLAW_STATE_DIR: directory,
        TMPDIR: process.env.TMPDIR,
        TMP: process.env.TMP,
        TEMP: process.env.TEMP,
      },
    });
    const failure = formatCliProcessFailure({ reason: "CLI source retirement failed", ...result });
    expect(result.signal, failure).toBeNull();
    expect(result.code, failure).toBe(0);
    expect(result.stdout, failure).toContain("cleanup joined after source retirement");
  },
);
