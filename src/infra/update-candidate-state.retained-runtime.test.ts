import fsSync from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  nextEventLoopTurn,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createCompiledSdkHost } from "../plugins/compiled-sdk-host.test-support.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { withRuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import {
  createStateInspectionScope,
  runStateInspectionCommand,
  withStateInspectionStaging,
} from "./update-candidate-state.process.js";

const inspectionFixture = vi.hoisted(() => ({ moduleUrl: "" }));
vi.mock("./runtime-process-entrypoints.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime-process-entrypoints.js")>();
  return {
    ...actual,
    runtimeProcessEntrypoints: {
      ...actual.runtimeProcessEntrypoints,
      ...Object.fromEntries(
        (["spawnBroker", "updateStateInspectionResource"] as const).map((name) => [
          name,
          {
            ...actual.runtimeProcessEntrypoints[name],
            get currentModuleUrl() {
              return (
                inspectionFixture.moduleUrl ||
                actual.runtimeProcessEntrypoints[name].currentModuleUrl
              );
            },
          },
        ]),
      ),
    },
  };
});

afterEach(() => {
  inspectionFixture.moduleUrl = "";
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("retains inspection broker and resource code through package replacement and native cleanup", async ({
  signal,
}) => {
  const base = tempDirs.make("retained-inspection-owner-");
  const root = path.join(base, "live");
  const retained = path.join(base, "retained");
  expect(
    createCompiledSdkHost(
      [
        runtimeProcessEntrypoints.spawnBroker,
        runtimeProcessEntrypoints.updateStateInspectionResource,
      ],
      () => {
        fsSync.mkdirSync(root);
        return root;
      },
    ),
  ).toBe(root);
  inspectionFixture.moduleUrl = pathToFileURL(path.join(root, "dist/updater.mjs")).href;
  const entered = createDeferred();
  const resume = createDeferred();
  let stagingRoot = "";
  let inspection: Promise<void> | undefined;
  const generation = withRuntimeWorkerGeneration(
    async (bind) => {
      bind((url) => {
        const relative = path.relative(root, fileURLToPath(url));
        return !relative.startsWith("..") && !path.isAbsolute(relative)
          ? pathToFileURL(path.join(retained, relative))
          : url;
      });
      await rename(root, retained);
      await mkdir(root);
      await writeFile(path.join(root, "package.json"), '{"name":"openclaw","type":"module"}');
      // Refused Doctor admission can leave even an unused scope without an explicit close.
      createStateInspectionScope();
      const commands = createStateInspectionScope();
      inspection = commands.run(async () => {
        entered.resolve();
        await resume.promise;
        await withStateInspectionStaging(base, async (directory) => {
          stagingRoot = directory;
          const result = await runStateInspectionCommand(
            [process.execPath, "-e", "process.stdout.write('retained')"],
            { signal, timeoutMs: 5_000 },
          );
          expect(result).toMatchObject({ code: 0, stdout: "retained" });
        });
      });
      await awaitGateBeforeSettlement(
        entered.promise,
        inspection,
        "Inspection never reached retained staging",
      );
    },
    async () => {
      expect(stagingRoot).not.toBe("");
      expect(fsSync.existsSync(stagingRoot)).toBe(false);
      await rm(retained, { recursive: true });
    },
  );
  void generation.catch(() => {});
  try {
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, generation, "Retained inspection did not start"),
      signal,
    );
    // Finalizers must retain code while the admitted callback has not launched its command yet.
    await nextEventLoopTurn();
    expect(fsSync.existsSync(retained)).toBe(true);
  } finally {
    resume.resolve();
    await inspection?.catch(() => {});
  }
  await generation;
  expect(fsSync.existsSync(retained)).toBe(false);
  expect(fsSync.readdirSync(base)).toEqual(["live"]);
});
