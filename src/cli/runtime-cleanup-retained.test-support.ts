import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";
import type { AgentHarness } from "../agents/harness/types.js";
import type { StagedPackageSwapParams } from "../infra/package-update-swap-contract.js";

export type CliRetainedCompositionFixture = {
  root: string;
  importRoot: string;
  swap: StagedPackageSwapParams;
};

/** Copy the prepared graph, never redirect missing imports at runtime. */
export async function copyCliRetainedCompositionGraph(params: {
  preparedEntrypoint: URL;
  root: string;
  importRoot: string;
}): Promise<void> {
  const entry = fileURLToPath(params.preparedEntrypoint);
  const marker = path.sep + "dist" + path.sep;
  const index = entry.lastIndexOf(marker);
  assert(index >= 0, "composition requires the prepared JavaScript graph");
  const source = entry.slice(0, index + marker.length);
  const destination = path.join(params.root, "dist");
  await fs.cp(source, destination, {
    recursive: true,
    filter: (file) => !file.endsWith(".map"),
  });
  const sourceUrl = pathToFileURL(source).href;
  const destinationUrl = pathToFileURL(path.join(params.importRoot, "dist") + path.sep).href;
  // Preserved compiler boundaries use absolute URLs. Move those declared graph
  // edges with the fixture; external dependency owners retain their real URLs.
  for (const item of await fs.readdir(destination, { recursive: true, withFileTypes: true })) {
    if (!item.isFile() || !/\.[cm]?js$/u.test(item.name)) {
      continue;
    }
    const file = path.join(item.parentPath, item.name);
    const original = await fs.readFile(file, "utf8");
    const relocated = original.replaceAll(sourceUrl, destinationUrl);
    if (relocated !== original) {
      await fs.writeFile(file, relocated);
    }
  }
  // Only dispatch is substituted. The entrypoint, runCli, registry, retention,
  // database and every finalizer remain the actual prepared production modules.
  await fs.writeFile(
    path.join(destination, "legacy-finalizer/src/cli/route.js"),
    "export async function tryRouteCli() { await globalThis.__openclawRetainedCompositionCommand(); return true; }\n",
  );
}

async function runComposition(fixture: CliRetainedCompositionFixture): Promise<void> {
  const moduleUrl = (relative: string) =>
    pathToFileURL(path.join(fixture.importRoot, "dist/legacy-finalizer/src", relative)).href;
  const physicalUrl = (relative: string) =>
    pathToFileURL(path.join(fixture.root, "dist/legacy-finalizer/src", relative)).href;
  const cleanupUrl = moduleUrl("cli/runtime-cleanup.js");
  const registryUrl = moduleUrl("agents/harness/registry.js");
  const lateResolutions: string[] = [];
  let settled = false;
  let observedParent: string | undefined;
  let retainedRegistryUrl: string | undefined;
  let retainedCleanupUrl: string | undefined;
  let resolvedRegistryUrl: string | undefined;
  // Observation only: nextResolve receives the original operands, and its
  // result/error is never changed. The production retained-import hook owns repair.
  let admittedParent: string | undefined;
  const sourceObservation = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL === cleanupUrl) {
        admittedParent = context.parentURL;
      }
      const result = nextResolve(specifier, context);
      if (settled && context.parentURL === retainedCleanupUrl && specifier.includes("harness/registry")) {
        resolvedRegistryUrl = result.url;
      }
      return result;
    },
  });
  let observation: ReturnType<typeof registerHooks> | undefined;
  const supervisors: Worker[] = [];
  const observeWorker = (worker: Worker) => supervisors.push(worker);
  process.on("worker", observeWorker);
  const { withCliProcessScope }: typeof import("./runtime-cleanup-scope.js") = await import(
    moduleUrl("cli/runtime-cleanup-scope.js")
  );
  const { runMainOrRootHelp }: typeof import("../entry.js") = await import(moduleUrl("entry.js"));
  const registry: typeof import("../agents/harness/registry.js") = await import(registryUrl);
  const runtime: typeof import("../plugins/runtime.js") = await import(moduleUrl("plugins/runtime.js"));
  const { createEmptyPluginRegistry }: typeof import("../plugins/registry-empty.js") = await import(
    moduleUrl("plugins/registry-empty.js")
  );
  const { acquireDebugProxyCaptureStoreAsync }: typeof import("../proxy-capture/store.async.js") =
    await import(moduleUrl("proxy-capture/store.async.js"));
  const { withRetainedUpdateRuntime }: typeof import("../infra/update-retained-runtime.js") =
    await import(moduleUrl("infra/update-retained-runtime.js"));
  const { swapStagedPackageInstall }: typeof import("../infra/package-update-swap.js") = await import(
    moduleUrl("infra/package-update-swap.js")
  );
  const { captureRuntimeWorkerSource }: typeof import("../infra/runtime-worker-generation.js") =
    await import(moduleUrl("infra/runtime-worker-generation.js"));
  let store: Awaited<ReturnType<typeof acquireDebugProxyCaptureStoreAsync>>["store"] | undefined;
  let resource: ReturnType<typeof setInterval> | undefined;
  let disposeCalls = 0;
  let committed = false;
  const phases: string[] = [];
  Object.assign(globalThis, {
    __openclawRetainedCompositionCommand: async () => {
      assert.equal(admittedParent, cleanupUrl, "cleanup did not load under the requested runtime spelling");
      console.log(
        JSON.stringify({
          phase: "cli-composition-admitted",
          requested: cleanupUrl,
          observed: admittedParent,
          physical: physicalUrl("cli/runtime-cleanup.js"),
        }),
      );
      const activeRegistry = createEmptyPluginRegistry();
      runtime.setActivePluginRegistry(activeRegistry);
      // Acquire outside the update worker generation: the executable owns this
      // resource until its later finalizers, not just until retention settlement.
      ({ store } = await acquireDebugProxyCaptureStoreAsync());
      await store.upsertSession({
        id: "retained-cli",
        startedAt: 1,
        mode: "fixture",
        sourceScope: "openclaw",
        sourceProcess: "fixture",
      });
      assert(supervisors.some((worker) => worker.threadId !== -1));
      const harness: AgentHarness = {
        id: "retained-cli",
        label: "Retained CLI fixture",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("composition fixture does not run model attempts");
        },
        loadModelCatalog: async () => {
          resource = setInterval(() => {}, 60_000);
          return [];
        },
        dispose: async () => {
          disposeCalls++;
          assert(settled, "harness disposal preceded update retention settlement");
          assert(resource?.hasRef(), "harness never acquired its referenced resource");
          assert(store && !store.isClosed, "shared state closed before harness disposal");
          phases.push("dispose-after-retention");
          await store.recordEvent({
            sessionId: "retained-cli",
            ts: 2,
            sourceScope: "openclaw",
            sourceProcess: "fixture",
            protocol: "https",
            direction: "outbound",
            kind: "request",
            flowId: "accepted-after-retention",
          });
          committed = true;
          phases.push("write-committed");
          clearInterval(resource);
        },
      };
      runtime.withPluginRegistrationContext(activeRegistry, "fixture", () =>
        registry.registerAgentHarness(harness),
      );
      const acquired = registry.getRegisteredAgentHarness(harness.id);
      assert(acquired, "real registry acquisition did not retain the harness");
      await acquired.harness.loadModelCatalog!({
        config: {},
        agentId: "fixture",
        agentDir: fixture.root,
        workspaceDir: fixture.root,
      });
      await withRetainedUpdateRuntime(cleanupUrl, async (retain) => {
        const retained = await retain({
          mutationRoots: [fixture.root],
          installTarget: fixture.swap.installTarget,
          timeoutMs: 30_000,
          assertCurrent() {},
        });
        assert(retained && retained.entries > 0, "running source was not retained");
        retainedRegistryUrl = captureRuntimeWorkerSource(new URL(registryUrl)).moduleUrl.href;
        retainedCleanupUrl = captureRuntimeWorkerSource(new URL(cleanupUrl)).moduleUrl.href;
        assert.notEqual(retainedRegistryUrl, registryUrl, "registry source was not retained");
        const result = await swapStagedPackageInstall({ ...fixture.swap, timeoutMs: 30_000 });
        assert.equal(result.status, "committed", JSON.stringify(result));
        await assert.rejects(fs.stat(new URL(physicalUrl("cli/runtime-cleanup.js"))), {
          code: "ENOENT",
        });
        phases.push("source-replaced");
      });
      settled = true;
      phases.push("retention-settled");
      observation = registerHooks({
        resolve(specifier, context, nextResolve) {
          if (context.parentURL === cleanupUrl && settled) {
            lateResolutions.push(specifier);
            observedParent = context.parentURL;
          }
          return nextResolve(specifier, context);
        },
      });
    },
  });
  const argv = [process.execPath, fileURLToPath(moduleUrl("entry.js")), "config", "get", "fixture"];
  process.argv = argv;
  await withCliProcessScope(() =>
    runMainOrRootHelp(argv, {
      finalize: async () => {
        assert.equal(disposeCalls, 1, "real CLI finalizer did not dispose the retained harness");
        assert(committed, "late accepted database write did not commit");
        assert(store?.isClosed, "canonical shared-state finalizer did not close the store");
        await assert.rejects(store.listSessions(), /closed/iu);
        assert(supervisors.length > 0);
        assert(supervisors.every((worker) => worker.threadId === -1), "native workers were not joined");
        assert.equal(observedParent, cleanupUrl, "late resolution escaped the runtime identity");
        assert(lateResolutions.some((specifier) => specifier.includes("harness/registry")));
        assert.equal(
          resolvedRegistryUrl,
          retainedRegistryUrl,
          "late registry resolution did not reach the retained generation",
        );
        assert(lateResolutions.some((specifier) => specifier.includes("ai")));
        phases.push("shared-state-closed");
        console.log(
          JSON.stringify({
            phase: "cli-retained-composition",
            requested: cleanupUrl,
            observed: observedParent,
            physical: physicalUrl("cli/runtime-cleanup.js"),
            phases,
            disposeCalls,
            supervisors: supervisors.length,
            joined: supervisors.every((worker) => worker.threadId === -1),
            databasePath: store.dbPath,
            retainedRegistryUrl,
            resolvedRegistryUrl,
          }),
        );
      },
    }),
  );
  observation?.deregister();
  sourceObservation.deregister();
  process.off("worker", observeWorker);
}

if (process.argv[2] === "--retained-cli-composition") {
  const fixture: CliRetainedCompositionFixture = JSON.parse(process.argv[3]!);
  await runComposition(fixture);
}
