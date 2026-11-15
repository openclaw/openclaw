import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  nextEventLoopTurn,
} from "../../test/helpers/promise.js";
import * as runtimeCompiler from "../plugins/runtime-compiler.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { listControlUiPluginCatalog } from "./control-ui-plugin-assets.js";

export function registerPluginCompilerLifecycleTests(activateFixture: () => unknown) {
  it("joins admitted browser compilation before registry shutdown settles", async () => {
    activateFixture();
    const entered = createDeferred();
    const resume = createDeferred();
    const compile = runtimeCompiler.createPluginBrowserCompiler;
    const gate = vi
      .spyOn(runtimeCompiler, "createPluginBrowserCompiler")
      .mockImplementationOnce(() => {
        const owner = compile();
        return {
          ...owner,
          async imports(source) {
            entered.resolve();
            await resume.promise;
            return owner.imports(source);
          },
        };
      });
    const catalog = listControlUiPluginCatalog();
    let closing: Promise<void> | undefined;
    try {
      await awaitGateBeforeSettlement(entered.promise, catalog, "catalog skipped compilation");
      closing = drainGlobalSingletonLifecycleState("plugin-registry");
      await awaitGateBeforeSettlement(
        nextEventLoopTurn(),
        closing,
        "registry shutdown skipped admitted compilation",
      );
      resume.resolve();
      await Promise.all([catalog, closing]);
    } finally {
      resume.resolve();
      await Promise.allSettled([catalog, closing]);
      gate.mockRestore();
    }
  });

  it("retains a failed compiler close for registry shutdown after the catalog request settles", async () => {
    activateFixture();
    let host: import("node:child_process").ChildProcess | undefined;
    const spawns = channel("child_process");
    const capture = (message: unknown) => {
      // SAFETY: Node publishes the newly created ChildProcess on this diagnostic channel.
      host = (message as { process: typeof host }).process;
    };
    spawns.subscribe(capture);
    const create = runtimeCompiler.createPluginBrowserCompiler;
    const compiler = vi
      .spyOn(runtimeCompiler, "createPluginBrowserCompiler")
      .mockImplementationOnce(() => {
        const owner = create();
        return {
          ...owner,
          async imports(source) {
            const imports = await owner.imports(source);
            const closed = once(host!, "close");
            host!.kill("SIGKILL");
            await closed;
            return imports;
          },
        };
      });
    try {
      await expect(listControlUiPluginCatalog()).rejects.toThrow(
        "Browser compiler did not close cleanly",
      );
      await listControlUiPluginCatalog();
      await expect(drainGlobalSingletonLifecycleState("plugin-registry")).rejects.toThrow(
        "Failed to reset",
      );
    } finally {
      spawns.unsubscribe(capture);
      compiler.mockRestore();
      delete runtimeCompiler.catalogOperations.failure;
    }
  });
}
