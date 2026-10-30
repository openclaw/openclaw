import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, it, afterAll } from "vitest";
import type { JsonTestResults } from "vitest/node";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { createManagedHandoffTestBinding } from "../../test/helpers/managed-handoff-isolation.js";
import { writePrivateUpdateHandoffChildGuard } from "../../test/helpers/private-update-handoff-child-guard.js";
import { withRuntimePreload } from "../../test/helpers/runtime-preload.js";
import { runVitestShutdownCommand } from "../../test/helpers/vitest-shutdown-command.js";
import { assertTestHomeSelection } from "../../test/test-home-policy.mts";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

const databasePath = process.env.OPENCLAW_TEST_PRIVATE_HANDOFF_PATH;
if (databasePath) {
  assert.equal(
    Reflect.get(globalThis, Symbol.for("openclaw.test.privateHandoffGuard")),
    databasePath,
  );
  assert.equal(path.resolve(databasePath), databasePath);
  assert.equal(fs.realpathSync(path.dirname(databasePath)), path.dirname(databasePath));
  const { resolveSecureTempRoot } = createRequire(import.meta.url)(
    "@openclaw/fs-safe/secure-temp-root",
  ) as typeof import("@openclaw/fs-safe/secure-temp-root");
  assert.equal(
    resolveSecureTempRoot({
      preferredDir: "/tmp/openclaw",
      fallbackPrefix: "openclaw",
      skipPreferredOnWindows: true,
    }),
    path.dirname(databasePath),
  );
  // Vitest is active here, but no Gateway/handoff consumer is imported before qualification.
  process.stderr.write("RELOAD_PRODUCT_STAGE importing-scenarios\n");
  await import("./server.plugin-reload-send-continuation.product.test-support.js");
  process.stderr.write("RELOAD_PRODUCT_STAGE scenarios-imported\n");
} else {
  const lifetime = createFixtureLifetime();
  // Compilation is module preparation; the prebound child still owns every product effect.
  const nodeExecPath = resolveTestNodeExecPath();
  const fixtureWorkers = createVitestWorkerRun(process.env, undefined, "full", nodeExecPath);
  afterAll(async () => {
    await lifetime.cleanup();
    await fixtureWorkers.dispose();
  });
  try {
    await fixtureWorkers.prepare();
  } catch (error) {
    await fixtureWorkers.dispose();
    throw error;
  }
  it("runs all three real reload continuations in a prebound owned process", async ({ signal }) =>
    lifetime.run(async () => {
      const root = lifetime.createTempDir("reload-send-product-");
      const handoff = path.join(root, "handoff");
      fs.mkdirSync(handoff, { mode: 0o700 });
      const binding = createManagedHandoffTestBinding(handoff);
      const reportPath = path.join(root, "results.json");
      const guard = writePrivateUpdateHandoffChildGuard(binding.databasePath, handoff);
      const home = path.join(root, "home");
      fs.mkdirSync(home, { mode: 0o700 });
      const env = withRuntimePreload(
        guard({
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          TMPDIR: root,
          TMP: root,
          TEMP: root,
        }),
        binding.preloadPath,
      );
      assertTestHomeSelection(env, "hermetic");
      // POSIX strict mode and the existing Windows Job owner both join descendants,
      // pipes and resource claims. Windows requires its native Job before launch:
      // the managed command's portable fallback is not an extinction receipt.
      if (process.platform === "win32") {
        const [{ isSupported }, { resolveManagedWindowsJobEntrypointUrl }] = await Promise.all([
          import("@openclaw/proc-safe/windows-job"),
          import("../../scripts/lib/managed-windows-job-entrypoint.mts"),
        ]);
        assert(
          isSupported() && fs.existsSync(resolveManagedWindowsJobEntrypointUrl()),
          "Product proof requires the existing native Windows Job owner",
        );
      }
      let output = "";
      let childPid: number | undefined;
      const { code } = await lifetime.track(
        runVitestShutdownCommand({
          bin: nodeExecPath,
          workerRun: fixtureWorkers,
          args: [
            "scripts/run-vitest.mjs",
            "src/gateway/server.plugin-reload-send-continuation.product.test.ts",
            "--reporter=json",
            "--outputFile=" + reportPath,
          ],
          signal,
          cwd: process.cwd(),
          env,
          onReady(child) {
            childPid = child.pid;
            child.stdout?.on("data", (chunk) => {
              output += String(chunk);
              process.stdout.write(chunk);
            });
            child.stderr?.on("data", (chunk) => {
              output += String(chunk);
              process.stderr.write(chunk);
            });
          },
        }),
      );
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as JsonTestResults;
      expect(code, output + "\n" + JSON.stringify(report)).toBe(0);
      expect(report.numPassedTests, output).toBe(3);
      expect(report.numFailedTests, output).toBe(0);
      expect(
        report.testResults.flatMap((file) =>
          file.assertionResults.map((test) => ({ title: test.title, status: test.status })),
        ),
      ).toEqual(
        ["resume", "followup", "failed-reload"].map((scenario) => ({
          title:
            "settles the original " + scenario + " after external reload without a model retry",
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
    }));
}
