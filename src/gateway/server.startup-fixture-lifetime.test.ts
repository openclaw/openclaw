import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test, type TestContext } from "vitest";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { hasErrnoCode } from "../infra/errno.js";
import { captureEnv } from "../test-utils/env.js";
import {
  gatewayStartupFixtureSource,
  createGatewayFixtureFork,
} from "./server.fixture-lifetime.test-support.js";

const runGatewayFixtureFork = createGatewayFixtureFork(afterAll);

// Each retained failure needs its own fork: a later case must not reset the failed owner.
for (const scenario of [
  { id: "public clean cleanup", missingTls: false, failCleanup: false, requiredJoin: false },
  {
    id: "public required cleanup failure",
    missingTls: false,
    failCleanup: true,
    requiredJoin: true,
  },
  {
    id: "kernel required cleanup failure",
    missingTls: true,
    failCleanup: true,
    requiredJoin: true,
  },
]) {
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
          kernelReturned: !scenario.missingTls,
          listenCalls: scenario.missingTls ? 0 : 1,
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
        if (!scenario.missingTls) {
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
  const run = createGatewayFixtureFork((cleanup) => cleanups.push(cleanup));
  let caseRoot: string | undefined;
  let completion: Promise<void> | undefined;
  let probeWorkerExited = false;
  try {
    for (const key of ["TMPDIR", "TMP", "TEMP"]) {
      process.env[key] = root;
    }
    completion = run(
      { signal: context.signal, onTestFinished: (callback) => finishers.push(callback) },
      (_repoRoot, ownedRoot) => {
        caseRoot = ownedRoot;
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
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (!hasErrnoCode(error, "ESRCH")) {
        throw error;
      }
      probeWorkerExited = true;
    }
    expect(probeWorkerExited).toBe(true);
    const sharedRoots = (await fs.readdir(root)).filter((name) =>
      name.startsWith("gateway-fixture-code-"),
    );
    expect(sharedRoots).toHaveLength(1);
    const config = path.join(root, sharedRoots[0]!, "vitest.config.ts");
    expect(cleanups).toHaveLength(1);
    await expect(cleanups[0]!()).rejects.toThrow("Fixture cleanup unverified");
    await expect(fs.access(config)).resolves.toBeUndefined();
    await expect(fs.access(caseRoot!)).resolves.toBeUndefined();
    expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
  } finally {
    await Promise.allSettled(completion ? [completion] : []);
    env.restore();
    if (!probeWorkerExited) {
      void probe.verifyCleanup(async () => {
        throw new Error(`Native receipt probe exit is unverified: ${root}`);
      });
    }
    // This independent PID observation permits probe disposal only; the fixture's
    // missing join receipt and retained code claim are never repaired or released.
    await probe.cleanup();
  }
});
