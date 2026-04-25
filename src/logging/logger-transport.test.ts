import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";

type LoggerModule = typeof import("./logger.js");

const logPathTracker = createSuiteLogPathTracker("openclaw-logger-transport-");
const importedModules: LoggerModule[] = [];
const unsubscribeCallbacks: Array<() => void> = [];

async function importLoggerModule(scope: string): Promise<LoggerModule> {
  const module = await importFreshModule<LoggerModule>(
    import.meta.url,
    `./logger.js?scope=${scope}`,
  );
  importedModules.push(module);
  module.setLoggerOverride({
    level: "info",
    file: logPathTracker.nextPath(),
  });
  return module;
}

describe("logger transport registry", () => {
  beforeAll(async () => {
    await logPathTracker.setup();
  });

  afterEach(() => {
    while (unsubscribeCallbacks.length > 0) {
      unsubscribeCallbacks.pop()?.();
    }
    while (importedModules.length > 0) {
      const module = importedModules.pop();
      module?.resetLogger();
      module?.setLoggerOverride(null);
    }
  });

  afterAll(async () => {
    await logPathTracker.cleanup();
  });

  it("shares late-registered transports across fresh logger module instances", async () => {
    const gatewayLoggerModule = await importLoggerModule("gateway");
    const pluginLoggerModule = await importLoggerModule("plugin");
    const gatewayLogger = gatewayLoggerModule.getLogger();
    const pluginLogger = pluginLoggerModule.getLogger();
    const records: unknown[] = [];

    unsubscribeCallbacks.push(
      pluginLoggerModule.registerLogTransport((record) => {
        records.push(record);
      }),
    );

    gatewayLogger.info("gateway message");
    pluginLogger.info("plugin message");

    expect(records).toHaveLength(2);
  });
});
