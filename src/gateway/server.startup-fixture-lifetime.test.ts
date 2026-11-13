import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test, type TestContext } from "vitest";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { captureEnv } from "../test-utils/env.js";
import {
  gatewayStartupFixtureSource,
  createGatewayFixtureFork,
} from "./server.fixture-lifetime.test-support.js";

// Prepare during collection; each isolated child keeps its own shutdown deadline.
const fixtureWorkers = createVitestWorkerRun();
afterAll(() => fixtureWorkers.dispose());
try {
  await fixtureWorkers.prepare();
} catch (error) {
  await fixtureWorkers.dispose();
  throw error;
}
const runGatewayFixtureFork = createGatewayFixtureFork(fixtureWorkers, afterAll);

// Each retained failure needs its own fork: a later case must not reset the failed owner.
for (const [id, missingTls, failCleanup] of [
  ["public clean cleanup", false, false],
  ["public required cleanup failure", false, true],
  ["kernel required cleanup failure", true, true],
] as const) {
  const scenario = { id, missingTls, failCleanup, requiredJoin: failCleanup };
  test(`startup fixture ownership: ${scenario.id}`, (context) =>
    runGatewayFixtureFork(
      context,
      (repoRoot, root) => gatewayStartupFixtureSource(repoRoot, root, scenario),
      (journal, text) => {
        const retained = scenario.failCleanup;
        const refusal = {
          rejected: retained,
          startupPreserved: retained,
          cleanupPreserved: retained,
        };
        const state = { home: retained, state: retained, selectorsIntact: retained };
        expect(journal, text).toMatchObject({
          combinedFailure: retained,
          nativeStartupMatches: true,
          startupCausePreserved: retained,
          cleanupIdentityPreserved: retained,
          cleanupFaultPreserved: retained,
          nativeCloseCalls: 1,
          nativeCloseStatus: retained ? "rejected" : "fulfilled",
          kernelReturned: !missingTls,
          listenCalls: missingTls ? 0 : 1,
          probeListening: retained,
          blockerListening: true,
          stopCalls: 1,
          lowerStops: 0,
          metadataRetains: 1,
          metadataReleases: retained ? 0 : 1,
          nativeOwnerRetained: retained,
          fixtureRelease: refusal,
          afterEach: refusal,
          cleanup: refusal,
          successorSetup: refusal,
          successorStarted: !retained,
          homeRestored: !retained,
          beforeCleanup: { home: true, state: true, selectorsIntact: true },
          afterCleanup: state,
          afterSuccessor: state,
          finally: {
            originalsJoined: true,
            nativeCloseCalls: 1,
            listenerResults: ["fulfilled", "fulfilled"],
            probeListening: false,
            blockerListening: false,
          },
        });
        if (!missingTls) {
          expect(journal, text).toMatchObject({ startupCode: "EADDRINUSE" });
        }
      },
    ));
}

test("retains shared code when a native fixture has no worker join receipt", async (context) => {
  const probe = createFixtureLifetime();
  const root = probe.createTempDir("gateway-fixture-receipt-probe-");
  const owner = createVitestResourceOwner(root);
  const env = captureEnv(["TMPDIR", "TMP", "TEMP"]);
  const cleanups: Array<() => Promise<void>> = [];
  const finishers: Array<Parameters<TestContext["onTestFinished"]>[0]> = [];
  let caseRoot: string | undefined;
  let codeRoot: string | undefined;
  let completion: Promise<void> | undefined;
  let probeWorkerExited = false;
  try {
    for (const key of ["TMPDIR", "TMP", "TEMP"]) {
      process.env[key] = root;
    }
    const run = createGatewayFixtureFork(fixtureWorkers, (cleanup) => cleanups.push(cleanup));
    completion = run(
      { signal: context.signal, onTestFinished: (callback) => finishers.push(callback) },
      (_repoRoot, ownedRoot, ownedCodeRoot) => {
        caseRoot = ownedRoot;
        codeRoot = ownedCodeRoot;
        return `
import fs from "node:fs";
import { test } from "vitest";
test("finishes without publishing the required join receipt", () => {
  fs.writeFileSync(${JSON.stringify(path.join(ownedRoot, "probe-worker.pid"))}, String(process.pid));
});
`;
      },
      () => {
        throw new Error("Journal validation must not run without a worker join receipt");
      },
    );
    const failure = await completion.catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "ENOENT" });
    for (const finish of finishers) {
      await expect(finish(context)).rejects.toBe(failure);
    }
    expect(caseRoot).toBeDefined();
    const pid = Number(await fs.readFile(path.join(caseRoot!, "probe-worker.pid"), "utf8"));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    probeWorkerExited = true;
    const sharedRoots = (await fs.readdir(root)).filter((name) =>
      name.startsWith("gateway-fixture-code-"),
    );
    expect(sharedRoots).toHaveLength(1);
    const config = path.join(root, sharedRoots[0]!, "vitest.config.ts");
    expect(cleanups).toHaveLength(1);
    await expect(cleanups[0]!()).rejects.toThrow("Fixture cleanup unverified");
    await Promise.all([config, caseRoot!, codeRoot!].map((file) => fs.access(file)));
    expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
  } finally {
    await Promise.allSettled(completion ? [completion] : []);
    env.restore();
    if (!probeWorkerExited) {
      void probe.verifyCleanup(async () => {
        throw new Error(`Native receipt probe exit is unverified: ${root}`);
      });
    }
    // This independent PID observation permits probe input disposal only; the
    // fixture's missing join receipt and retained code claim are never repaired or released.
    if (probeWorkerExited && codeRoot) {
      await fs.rm(codeRoot, { recursive: true, force: true });
    }
    await probe.cleanup();
  }
});
