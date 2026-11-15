import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { definePluginReloadProductTest } from "./server.plugin-reload-product-fixture.test-support.js";

await definePluginReloadProductTest(
  {
    name: "runs Bob's allowed and revoked retained sends in a prebound owned process",
    prefix: "reload-send-revocation-",
    testFile: "src/gateway/server.plugin-reload-send-revocation.product.test.ts",
    loadScenarios: () => import("./server.plugin-reload-send-revocation.product.test-support.js"),
  },
  ({ code, output, report, binding, handoff, childPid }) => {
    expect(code, output + "\n" + JSON.stringify(report)).toBe(0);
    expect(report.numPassedTests, output).toBe(2);
    expect(report.numFailedTests, output).toBe(0);
    expect(
      report.testResults.flatMap((file) =>
        file.assertionResults.map((test) => ({ title: test.title, status: test.status })),
      ),
    ).toEqual(
      ["allowed", "revoked"].map((scenario) => ({
        title:
          "settles Bob's selected retained send when Bob is " +
          scenario +
          " before replay admission",
        status: "passed",
      })),
    );
    binding.assertPath();
    const proofs = ["allowed", "revoked"].map(
      (scenario) =>
        JSON.parse(
          fs.readFileSync(path.join(handoff, "revocation-case-" + scenario + ".json"), "utf8"),
        ) as {
          scenario: string;
          pid: number;
          runtime: string;
          sendStarts: number;
          effects: number;
          wakes: number;
          notices: number;
          barrierFired: number;
          revocation?: { method: string; bobRefused: boolean };
          databasePath: string;
        },
    );
    expect(
      proofs.map(
        ({
          scenario,
          sendStarts,
          effects,
          wakes,
          notices,
          barrierFired,
          databasePath: observed,
        }) => ({
          scenario,
          sendStarts,
          effects,
          wakes,
          notices,
          barrierFired,
          databasePath: observed,
        }),
      ),
    ).toEqual(
      ["allowed", "revoked"].map((scenario) => ({
        scenario,
        sendStarts: 1,
        effects: scenario === "revoked" ? 0 : 1,
        wakes: scenario === "revoked" ? 0 : 1,
        notices: scenario === "revoked" ? 1 : 0,
        barrierFired: 1,
        databasePath: binding.databasePath,
      })),
    );
    expect(proofs[1]?.revocation?.bobRefused).toBe(true);
    console.log("RELOAD_REVOCATION_CASES", JSON.stringify(proofs));
    console.log(
      "RELOAD_REVOCATION_CHILD",
      JSON.stringify({
        pid: childPid,
        processTreeJoined: true,
        cases: report.numPassedTests,
        databasePath: binding.databasePath,
      }),
    );
  },
);
