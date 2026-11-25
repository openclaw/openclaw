import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { definePluginReloadProductTest } from "./server.plugin-reload-product-fixture.test-support.js";

await definePluginReloadProductTest(
  {
    name: "runs all three real reload continuations in a prebound owned process",
    prefix: "reload-send-product-",
    testFile: "src/gateway/server.plugin-reload-send-continuation.product.test.ts",
    loadScenarios: async () => {
      process.stderr.write("RELOAD_PRODUCT_STAGE importing-scenarios\n");
      await import("./server.plugin-reload-send-continuation.product.test-support.js");
      process.stderr.write("RELOAD_PRODUCT_STAGE scenarios-imported\n");
    },
    relayOutput: true,
  },
  ({ code, output, report, binding, handoff, childPid }) => {
    expect(code, output + "\n" + JSON.stringify(report)).toBe(0);
    expect(report.numPassedTests, output).toBe(3);
    expect(report.numFailedTests, output).toBe(0);
    expect(
      report.testResults.flatMap((file) =>
        file.assertionResults.map((test) => ({ title: test.title, status: test.status })),
      ),
    ).toEqual(
      ["resume", "followup", "failed-reload"].map((scenario) => ({
        title: "settles the original " + scenario + " after external reload without a model retry",
        status: "passed",
      })),
    );
    binding.assertPath();
    const proofs = ["resume", "followup", "failed-reload"].map(
      (scenario) =>
        JSON.parse(
          fs.readFileSync(path.join(handoff, "reload-case-" + scenario + ".json"), "utf8"),
        ) as {
          scenario: string;
          pid: number;
          runtime: string;
          sendStarts: number;
          effects: number;
          wakes: number;
          databasePath: string;
        },
    );
    expect(
      proofs.map(({ scenario, sendStarts, effects, wakes, databasePath: observed }) => ({
        scenario,
        sendStarts,
        effects,
        wakes,
        databasePath: observed,
      })),
    ).toEqual(
      ["resume", "followup", "failed-reload"].map((scenario) => ({
        scenario,
        sendStarts: 1,
        effects: scenario === "failed-reload" ? 0 : 1,
        wakes: 1,
        databasePath: binding.databasePath,
      })),
    );
    console.log("RELOAD_PRODUCT_CASES", JSON.stringify(proofs));
    console.log(
      "RELOAD_PRODUCT_CHILD",
      JSON.stringify({
        pid: childPid,
        processTreeJoined: true,
        cases: report.numPassedTests,
        databasePath: binding.databasePath,
      }),
    );
  },
);
