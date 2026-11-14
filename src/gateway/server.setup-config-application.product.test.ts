import { expect } from "vitest";
import { definePluginReloadProductTest } from "./server.plugin-reload-product-fixture.test-support.js";

await definePluginReloadProductTest(
  {
    name: "reports deferred Setup writes through a real Gateway and resumes after the held turn",
    prefix: "setup-application-product-",
    testFile: "src/gateway/server.setup-config-application.product.test.ts",
    loadScenarios: async () => {
      process.stderr.write("SETUP_PRODUCT_STAGE importing-scenarios\n");
      await import("./server.setup-config-application.product.test-support.js");
    },
    relayOutput: true,
  },
  ({ code, output, report, binding }) => {
    expect(code, output + "\n" + JSON.stringify(report)).toBe(0);
    expect(report.numPassedTests, output).toBe(1);
    expect(report.numFailedTests, output).toBe(0);
    binding.assertPath();
  },
);
