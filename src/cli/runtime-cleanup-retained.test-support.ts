import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";
import type { AgentHarness } from "../agents/harness/types.js";
import { hasNodeErrorCode } from "../infra/path-guards.js";
import type { StagedPackageSwapParams } from "../infra/package-update-swap-contract.js";
import { cliRetainedCompositionModules } from "./cli-entrypoint.test-support.js";

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
  runtime: "node" | "node-short-path";
}): Promise<void> {
  const entry = fileURLToPath(params.preparedEntrypoint);
  const marker = path.sep + "dist" + path.sep;
  const index = entry.lastIndexOf(marker);
  assert(index >= 0, "composition requires the prepared JavaScript graph");
  const source = entry.slice(0, index + marker.length);
  const destination = path.join(params.root, "dist");
  const manifest: {
    identity: string;
    outputs: Record<string, string>;
    fixtures?: { retainedCliComposition?: string[] };
  } = JSON.parse(
    await fs.readFile(path.join(source, "..", "manifest.json"), "utf8"),
  );
  const files = manifest.fixtures?.retainedCliComposition;
  assert(files, "composition requires the compiler-owned fixture graph");
  for (const name of files) {
    const target = path.join(destination, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(source, name), target);
  }
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
  const route = "legacy-finalizer/src/cli/route.js";
  await fs.writeFile(
    path.join(destination, route),
    "export async function tryRouteCli() { await globalThis.__openclawRetainedCompositionCommand(); return true; }\n",
  );
  // Export only relative names and digests, never compiler input paths or config.
  // This completes before child launch, outside its unchanged deadlock guard.
  const proofDirectory = process.env.OPENCLAW_RETAINED_CLI_PROOF_DIR;
  if (proofDirectory) {
    const copied = [];
    for (const name of [...new Set([...files, route])].toSorted()) {
      const bytes = await fs.readFile(path.join(destination, name));
      copied.push({ path: name, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    const inventory = {
      runtime: params.runtime,
      manifestIdentity: manifest.identity,
      fullOutputCount: Object.keys(manifest.outputs).length,
      selectedFileCount: files.length,
      copiedFileCount: copied.length,
      substitutions: [route],
      selected: files.map((name) => ({ path: name, sha256: manifest.outputs[name] })),
      copied,
    };
    await fs.mkdir(proofDirectory, { recursive: true });
    await fs.writeFile(
      path.join(proofDirectory, params.runtime + ".json"),
      JSON.stringify(inventory, null, 2) + "\n",
    );
  }
}

async function runComposition(fixture: CliRetainedCompositionFixture): Promise<void> {
  const started = performance.now();
  const observePhase = (stage: string) =>
    console.log(
      JSON.stringify({
        phase: "cli-composition-progress",
        stage,
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
  const moduleUrl = (relative: string) =>
    pathToFileURL(path.join(fixture.importRoot, "dist/legacy-finalizer/src", relative)).href;
  const physicalUrl = (relative: string) =>
    pathToFileURL(path.join(fixture.root, "dist/legacy-finalizer/src", relative)).href;
  const cleanupUrl = moduleUrl(cliRetainedCompositionModules.cleanup);
  const registryUrl = moduleUrl(cliRetainedCompositionModules.registry);
  const lateResolutions: string[] = [];
  let settled = false;
  let observedParent: string | undefined;
  let retainedRegistryUrl: string | undefined;
  let retainedCleanupUrl: string | undefined;
  let resolvedRegistryUrl: string | undefined;
  // Observation only: nextResolve receives the original operands, and its
  // result/error is never changed. The production retained-import hook owns repair.
  let admittedParent: string | undefined;
  let reportedResolutionFailure = false;
  const sourceObservation = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL === cleanupUrl) {
        admittedParent = context.parentURL;
      }
      let result: ReturnType<typeof nextResolve>;
      try {
        result = nextResolve(specifier, context);
      } catch (error) {
        // Observe the reporter failure itself, never infer the masked disposer error.
        if (
          !reportedResolutionFailure &&
          context.parentURL === cleanupUrl &&
          specifier === "../infra/errors.js" &&
          hasNodeErrorCode(error, "ERR_MODULE_NOT_FOUND")
        ) {
          reportedResolutionFailure = true;
          console.log(
            JSON.stringify({
              phase: "cli-composition-resolution-failed",
              parent: context.parentURL,
              requested: new URL(specifier, context.parentURL).href,
              code: "ERR_MODULE_NOT_FOUND",
            }),
          );
        }
        throw error;
      }
      if (
        settled &&
        context.parentURL === retainedCleanupUrl &&
        specifier.includes("harness/registry")
      ) {
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
    moduleUrl(cliRetainedCompositionModules.scope)
  );
  const { runMainOrRootHelp }: typeof import("../entry.js") = await import(
    moduleUrl(cliRetainedCompositionModules.entry)
  );
  const registry: typeof import("../agents/harness/registry.js") = await import(registryUrl);
  const runtime: typeof import("../plugins/runtime.js") = await import(
    moduleUrl(cliRetainedCompositionModules.pluginRuntime)
  );
  const { createEmptyPluginRegistry }: typeof import("../plugins/registry-empty.js") = await import(
    moduleUrl(cliRetainedCompositionModules.emptyRegistry)
  );
  const { acquireDebugProxyCaptureStoreAsync }: typeof import("../proxy-capture/store.async.js") =
    await import(moduleUrl(cliRetainedCompositionModules.captureStore));
  const { withRetainedUpdateRuntime }: typeof import("../infra/update-retained-runtime.js") =
    await import(moduleUrl(cliRetainedCompositionModules.retention));
  const { swapStagedPackageInstall }: typeof import("../infra/package-update-swap.js") =
    await import(moduleUrl(cliRetainedCompositionModules.swap));
  const { captureRuntimeWorkerSource }: typeof import("../infra/runtime-worker-generation.js") =
    await import(moduleUrl(cliRetainedCompositionModules.workerGeneration));
  observePhase("owners-loaded");
  let store: Awaited<ReturnType<typeof acquireDebugProxyCaptureStoreAsync>>["store"] | undefined;
  let resource: ReturnType<typeof setInterval> | undefined;
  let disposeCalls = 0;
  let committed = false;
  const phases: string[] = [];
  Object.assign(globalThis, {
    __openclawRetainedCompositionCommand: async () => {
      assert.equal(
        admittedParent,
        cleanupUrl,
        "cleanup did not load under the requested runtime spelling",
      );
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
      observePhase("store-acquired");
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
      observePhase("retention-start");
      await withRetainedUpdateRuntime(cleanupUrl, async (retain) => {
        const retained = await retain({
          mutationRoots: [fixture.root],
          installTarget: fixture.swap.installTarget,
          timeoutMs: 30_000,
          assertCurrent() {},
        });
        observePhase("retention-done");
        assert(retained && retained.entries > 0, "running source was not retained");
        retainedRegistryUrl = captureRuntimeWorkerSource(new URL(registryUrl)).moduleUrl.href;
        retainedCleanupUrl = captureRuntimeWorkerSource(new URL(cleanupUrl)).moduleUrl.href;
        assert.notEqual(retainedRegistryUrl, registryUrl, "registry source was not retained");
        observePhase("swap-start");
        const result = await swapStagedPackageInstall({ ...fixture.swap, timeoutMs: 30_000 });
        observePhase("swap-done");
        assert.equal(result.status, "committed", JSON.stringify(result));
        await assert.rejects(fs.stat(new URL(physicalUrl("cli/runtime-cleanup.js"))), {
          code: "ENOENT",
        });
        phases.push("source-replaced");
      });
      settled = true;
      phases.push("retention-settled");
      observePhase("retention-settled");
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
  const argv = [process.execPath, fileURLToPath(moduleUrl(cliRetainedCompositionModules.entry)), "config", "get", "fixture"];
  process.argv = argv;
  await withCliProcessScope(() =>
    runMainOrRootHelp(argv, {
      finalize: async () => {
        observePhase("finalizer");
        if (disposeCalls !== 1) {
          // Bind the failure receipt to the unchanged assertion at this boundary.
          console.log(
            JSON.stringify({
              phase: "cli-composition-disposal-failed",
              actual: disposeCalls,
              expected: 1,
            }),
          );
        }
        assert.equal(disposeCalls, 1, "real CLI finalizer did not dispose the retained harness");
        assert(committed, "late accepted database write did not commit");
        assert(store?.isClosed, "canonical shared-state finalizer did not close the store");
        await assert.rejects(store.listSessions(), /closed/iu);
        assert(supervisors.length > 0);
        assert(
          supervisors.every((worker) => worker.threadId === -1),
          "native workers were not joined",
        );
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
