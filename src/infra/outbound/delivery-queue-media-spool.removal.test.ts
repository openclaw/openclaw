import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { configureFsSafeNative } from "@openclaw/fs-safe/config";
import { afterEach, assert, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createWarnLogCapture } from "../../logging/test-helpers/warn-log-capture.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { observeMainThreadFs } from "../../test-utils/main-thread-fs-spies.test-support.js";
import * as workerCpu from "../worker-cpu.js";
import { releaseSpoolArtifacts } from "./delivery-queue-media-spool.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const artifactName = "00000000-0000-4000-8000-000000000001.ogg";
const createWorker = workerCpu.createCpuTrackedWorker;
const retireFilesystem = () =>
  drainGlobalSingletonLifecycleState("close", {
    measureReset: (name, reset) =>
      name === "openclaw.workspaceFilesystem" ? reset() : Promise.resolve(),
  });

afterEach(async () => {
  await retireFilesystem();
  configureFsSafeNative({ mode: undefined });
  vi.restoreAllMocks();
});

async function fixture() {
  const stateDir = await fs.realpath(dirs.make("spool-removal-"));
  const root = path.join(stateDir, "delivery-queue-media");
  await fs.mkdir(root);
  const artifact = path.join(root, artifactName);
  await fs.writeFile(artifact, "original");
  return { stateDir, root, artifact };
}

it("removes retained artifacts without main-thread guarded filesystem calls", async () => {
  const { stateDir, artifact } = await fixture();
  const observer = observeMainThreadFs();
  try {
    await releaseSpoolArtifacts([artifact], stateDir);
  } finally {
    observer[Symbol.dispose]();
  }
  console.log(
    JSON.stringify({
      operation: "releaseSpoolArtifacts",
      calls: observer.calls(),
      stacks: observer.stacks(),
    }),
  );
  expect(observer.calls()).toEqual({});
  await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
});

it.for([
  { mode: "off", replaceRoot: true, retireWorker: false },
  { mode: "require", replaceRoot: false, retireWorker: false },
  { mode: "off", replaceRoot: false, retireWorker: true },
] as const)(
  "joins guarded removal after request retirement (mode=$mode, replace=$replaceRoot, retire=$retireWorker)",
  async ({ mode, replaceRoot, retireWorker }, { signal }) => {
    const { stateDir, root, artifact } = await fixture();
    const receipts = await openFixtureReceiptChannel();
    const warnings = createWarnLogCapture("spool-removal");
    const preload = path.join(stateDir, "hold-removal.mjs");
    const hooks = pathToFileURL(
      createRequire(import.meta.url).resolve("@openclaw/fs-safe/test-hooks"),
    );
    const config = pathToFileURL(
      createRequire(import.meta.url).resolve("@openclaw/fs-safe/config"),
    );
    await fs.writeFile(
      preload,
      `
      import { __setFsSafeTestHooksForTest } from ${JSON.stringify(hooks.href)};
      import { getFsSafeNativeConfig } from ${JSON.stringify(config.href)};
      ${fixtureReceiptClientSource(receipts.endpoint)}
      __setFsSafeTestHooksForTest({
        beforeRootFallbackMutation: async (operation, target) => {
          if (operation !== "remove" || target !== ${JSON.stringify(artifact)}) return;
          sendReceipt("remove", getFsSafeNativeConfig().mode);
          await awaitRelease("remove", "continue");
        },
      });
    `,
    );
    let removalWorker: Worker | undefined;
    vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation(
      (filename, options, request) => {
        if (path.basename(filename.toString()) !== "fs-safe-copy.worker.js") {
          return createWorker(filename, options, request);
        }
        removalWorker = createWorker(
          filename,
          {
            ...options,
            execArgv: [...(options?.execArgv ?? []), "--import", pathToFileURL(preload).href],
          },
          request,
        );
        return removalWorker;
      },
    );
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    configureFsSafeNative({ mode });
    let settled = false;
    const pending = withCommandProcessScope(async (stop) => {
      stop();
      await releaseSpoolArtifacts([artifact], stateDir);
    }).finally(() => {
      settled = true;
    });
    const retiredRoot = path.join(stateDir, "retired-root");
    let retirement: Promise<void> | undefined;
    let retirementSettled = false;
    try {
      await withinTest(
        Promise.race([
          receipts.waitFor("remove", mode),
          pending.then(() => {
            throw new Error("Removal settled before its physical guard was observed");
          }),
        ]),
        signal,
      );
      expect(settled).toBe(false);
      assert(removalWorker, "The actual filesystem worker must own the held removal");
      expect(await fs.readFile(artifact, "utf8")).toBe("original");
      if (retireWorker) {
        retirement = retireFilesystem().then(() => {
          retirementSettled = true;
        });
        await setImmediate();
        expect([settled, retirementSettled]).toEqual([false, false]);
        expect(terminate.mock.contexts.filter((worker) => worker === removalWorker)).toEqual([]);
      }
      if (replaceRoot) {
        await fs.rename(root, retiredRoot);
        await fs.mkdir(root);
        await fs.writeFile(artifact, "replacement");
      }
      receipts.release("remove", "continue");
      await pending;
      await (retirement ?? retireFilesystem());
      await withinTest(receipts.waitForExit("remove"), signal);
      expect(settled).toBe(true);
      expect(removalWorker.threadId).toBe(-1);
      if (replaceRoot) {
        expect(await fs.readFile(artifact, "utf8")).toBe("replacement");
        expect(await fs.readFile(path.join(retiredRoot, artifactName), "utf8")).toBe("original");
        expect(await warnings.findText("failed to remove delivery queue media artifact")).toContain(
          "FsSafeError",
        );
      } else {
        await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
        const warning = await warnings.findText("failed to remove delivery queue media artifact");
        if (retireWorker) {
          expect(warning).toContain("worker task pool closed");
        } else {
          expect(warning).toBeUndefined();
        }
      }
    } finally {
      receipts.release("remove", "continue");
      try {
        await pending;
      } finally {
        await (retirement ?? retireFilesystem());
        await receipts.close();
        warnings.cleanup();
      }
    }
  },
);
