import { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { createDeferred, nextEventLoopTurn, withinTest } from "../helpers/promise.js";
import { runVitestShutdownCommand } from "../helpers/vitest-shutdown-command.js";

it.for(["before-ready", "success", "failure"] as const)(
  "joins a managed borrower through %s",
  async (mode, { signal }) => {
    const lifetime = createFixtureLifetime();
    const child = new ChildProcess();
    const initialMessages = child.listenerCount("message");
    const initialCloses = child.listenerCount("close");
    const value = { completed: true };
    const failure = new Error("controlled command failure");
    const command = createDeferred<typeof value>();
    const events: string[] = [];
    let closed = false;
    let expectedDisposalFailure = false;
    let observed: Promise<{ value: typeof value | undefined; error: unknown }> | undefined;
    const close = () => {
      if (!closed) {
        closed = true;
        events.push("close");
        child.emit("close", 0, null);
      }
    };

    try {
      const { owner } = await lifetime.acquire(async () => {
        const acquiredOwner = createVitestWorkerRun();
        return {
          owner: acquiredOwner,
          async cleanup() {
            command.resolve(value);
            close();
            await observed;
            if (expectedDisposalFailure) {
              await expect(acquiredOwner.dispose()).rejects.toBe(failure);
              // No process or preparation existed. Remove only this exact
              // empty generation retained for the rejected borrower.
              expect(child.pid).toBeUndefined();
              const directory = acquiredOwner.descriptor.directory;
              expect(await fs.promises.readdir(directory)).toEqual(["package.json"]);
              const manifest = path.join(directory, "package.json");
              expect(await fs.promises.readFile(manifest, "utf8")).toBe('{"type":"module"}\n');
              await fs.promises.unlink(manifest);
              await fs.promises.rmdir(directory);
            } else {
              await acquiredOwner.dispose();
            }
            expect(fs.existsSync(acquiredOwner.descriptor.directory)).toBe(false);
          },
        };
      });

      const running = owner.withBorrower(async (onReady) => {
        if (mode === "before-ready") {
          throw failure;
        }
        onReady(child);
        events.push("attached");
        return command.promise;
      });
      observed = running.then(
        (result) => {
          events.push("settled");
          return { value: result, error: undefined };
        },
        (error: unknown) => {
          events.push("settled");
          return { value: undefined, error };
        },
      );

      if (mode === "before-ready") {
        const result = await withinTest(observed, signal);
        expect(result.error).toBe(failure);
        expect(child.listenerCount("message")).toBe(initialMessages);
        expect(child.listenerCount("close")).toBe(initialCloses);
        await nextEventLoopTurn();
        return;
      }

      if (mode === "failure") {
        expectedDisposalFailure = true;
        command.reject(failure);
      } else {
        command.resolve(value);
      }

      // Only native Promise continuations remain; drain them before close.
      await nextEventLoopTurn();
      expect(events).toEqual(["attached"]);
      expect(child.listenerCount("message")).toBe(initialMessages + 1);
      expect(fs.existsSync(owner.descriptor.directory)).toBe(true);
      close();
      const result = await withinTest(observed, signal);
      expect(events).toEqual(["attached", "close", "settled"]);
      expect(child.listenerCount("message")).toBe(initialMessages);
      if (mode === "failure") {
        expect(result.error).toBe(failure);
      } else {
        expect(result.value).toBe(value);
        expect(result.error).toBeUndefined();
      }
    } finally {
      await lifetime.cleanup();
    }
  },
);

it.for(["full", "runtime", "tooling"] as const)(
  "preserves the %s preset through a private child bootstrap and native CLI shim",
  async (preset, { signal }) => {
    const lifetime = createFixtureLifetime();
    try {
      const { owner } = await lifetime.acquire(async () => {
        const acquiredOwner = createVitestWorkerRun({}, undefined, preset);
        return { owner: acquiredOwner, cleanup: () => acquiredOwner.dispose() };
      });
      const fixture = path.join(lifetime.createTempDir("worker-descriptor-"), "descriptor.mts");
      fs.writeFileSync(
        fixture,
        `const { getVitestWorkerDescriptor } = await import(process.argv[2]);
process.stdout.write(JSON.stringify({ descriptor: getVitestWorkerDescriptor(), args: process.argv.slice(3) }));`,
      );
      const shim = path.join(path.dirname(fixture), "shim.mts");
      fs.writeFileSync(
        shim,
        `import { runNodeCliShim } from ${JSON.stringify(new URL("../../scripts/lib/tsx-cli-shim.mjs", import.meta.url).href)};
import { createVitestWorkerRun } from ${JSON.stringify(new URL("../../scripts/lib/vitest-worker-run.mts", import.meta.url).href)};
import { getVitestWorkerDescriptor } from ${JSON.stringify(new URL("../../scripts/lib/vitest-worker-descriptor.mts", import.meta.url).href)};
const workers = createVitestWorkerRun(process.env, getVitestWorkerDescriptor());
let result;
try {
  result = await runNodeCliShim(import.meta.url, { implementation: "./descriptor.mts", workerRun: workers });
} finally {
  await workers.dispose({ interrupted: Boolean(result?.interrupted) });
}`,
      );
      const result = await lifetime.track(
        runVitestShutdownCommand({
          workerRun: owner,
          args: [
            shim,
            pathToFileURL(
              path.resolve(import.meta.dirname, "../../scripts/lib/vitest-worker-descriptor.mts"),
            ).href,
            "fixture-argument",
          ],
          signal,
        }),
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        descriptor: owner.descriptor,
        args: ["fixture-argument"],
      });
    } finally {
      await lifetime.cleanup();
    }
  },
);
