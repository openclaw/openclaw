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
  await import("./server.plugin-reload-send-revocation.product.test-support.js");
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
  it("runs Bob's allowed and revoked retained sends in a prebound owned process", async ({
    signal,
  }) =>
    lifetime.run(async () => {
      const root = lifetime.createTempDir("reload-send-revocation-");
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
            "src/gateway/server.plugin-reload-send-revocation.product.test.ts",
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
            });
            child.stderr?.on("data", (chunk) => {
              output += String(chunk);
            });
          },
        }),
      );
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as JsonTestResults;
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
    }));
}
