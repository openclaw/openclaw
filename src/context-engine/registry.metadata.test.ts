import { expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { execNodeEvalSync } from "../test-utils/node-process.js";
import { LegacyContextEngine } from "./legacy.js";
import {
  registerContextEngineInRegistry,
  resolveContextEngine,
  resolveContextEngineTranscriptByteLimit,
} from "./registry.js";

it("releases the completed factory context while retaining its closed resource owner", () => {
  const output = execNodeEvalSync(
    `import assert from "node:assert/strict";
     import { AsyncLocalStorage } from "node:async_hooks";
     import { setImmediate as nextTurn } from "node:timers/promises";
     import { queryObjects } from "node:v8";
     import { AsyncWorkScope } from ${JSON.stringify(new URL("../shared/async-work-scope.ts", import.meta.url).href)};
     import { ContextEngineFactoryResources, disposeContextEngineSources } from ${JSON.stringify(new URL("./registry.resources.ts", import.meta.url).href)};

     class RunState {}
     const carrier = new AsyncLocalStorage();
     for (const fails of [false, true]) {
       const parent = new AsyncWorkScope();
       const failure = new Error("claim release failed");
       const source = carrier.run(new RunState(), () => parent.run(() =>
         new ContextEngineFactoryResources([{ release: async () => { if (fails) throw failure; } }]),
       ));
       const finish = Promise.withResolvers();
       const started = Promise.withResolvers();
       const disposal = disposeContextEngineSources(undefined, [source], async () => {
         started.resolve();
         await finish.promise;
         assert.ok(carrier.getStore() instanceof RunState);
       });
       const outcome = disposal.catch(error => error);
       await started.promise;
       await nextTurn();
       assert.equal(queryObjects(RunState), 1, "pending disposal retains its origin");
       finish.resolve();
       assert.equal(await outcome, fails ? failure : undefined);
       await parent.drain();
       await nextTurn();
       const control = new WeakRef({});
       await nextTurn();
       assert.equal(queryObjects(RunState), 0, "settled owner releases captured context");
       assert.equal(control.deref(), undefined, "GC control");
       let invoked = false;
       await assert.rejects(source.run(() => { invoked = true; }), /Async work scope is closed/);
       assert.throws(() => source.runCleanup(() => { invoked = true; }), /Async work scope is closed/);
       assert.equal(invoked, false);
     }
     carrier.disable();
     console.log("factory contexts released");`,
    { imports: ["./scripts/tsx.mjs"], timeout: 10_000 },
  );
  expect(output.trim()).toBe("factory contexts released");
});

it("retains the admitted byte budget across separate core and SDK module instances", async () => {
  const registry = createEmptyPluginRegistry();
  registerContextEngineInRegistry(registry, "legacy", () => new LegacyContextEngine(), "core");
  await withPluginRuntimeRegistryScope(registry, async () => {
    const engine = await resolveContextEngine({
      agents: { defaults: { compaction: { maxActiveTranscriptBytes: "32kb" } } },
    });
    try {
      expect(resolveContextEngineTranscriptByteLimit(engine)).toBe(32_768);
      // Built plugin SDK artifacts load their own copy of the registry module.
      vi.resetModules();
      const sdkRegistry = await import("./registry.js");
      expect(sdkRegistry.resolveContextEngineTranscriptByteLimit(engine)).toBe(32_768);
    } finally {
      await engine.dispose?.();
    }
  });
});
