import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, it, type TestContext } from "vitest";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { withEnvAsync } from "../../src/test-utils/env.js";
import { createDeferred, withTestTimeout } from "./promise.js";
import { runQaGatewayTestFixture } from "./qa-gateway-test-lifetime.js";

function testOwner(signal: AbortSignal, events: string[] = []) {
  const hooks: Array<Parameters<TestContext["onTestFinished"]>[0]> = [];
  return {
    context: {
      signal,
      onTestFinished: (hook: Parameters<TestContext["onTestFinished"]>[0]) => {
        events.push("registered");
        hooks.push(hook);
      },
    },
    finish: async (context: TestContext) => {
      for (const hook of hooks) {
        await hook(context);
      }
    },
  };
}

it("joins the actual cancelled body and ordered cleanup before finishing the test", async (context) => {
  const controller = new AbortController();
  const reason = new Error("test cancelled");
  const events: string[] = [];
  const owner = testOwner(controller.signal, events);
  const bodyEntered = createDeferred();
  const gatewayCleanup = createDeferred();
  const releaseCleanup = createDeferred();
  let scratch: string | undefined;
  const run = runQaGatewayTestFixture(
    owner.context,
    async ({ signal, createTempDir }) => {
      scratch = createTempDir("qa-gateway-test-work-");
      events.push("body");
      bodyEntered.resolve();
      try {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(reason), { once: true });
        });
      } finally {
        events.push("body-settled");
      }
    },
    () => {
      events.push("client");
    },
    async () => {
      events.push("gateway-start");
      gatewayCleanup.resolve();
      await releaseCleanup.promise;
      events.push("gateway-end");
    },
    () => {
      events.push("provider");
    },
  );
  const outcome = run.catch((error: unknown) => error);
  let finishing: Promise<void> | undefined;
  let finished = false;
  try {
    await withTestTimeout(bodyEntered.promise, 1_000, "fixture body did not start");
    expect(events).toEqual(["registered", "body"]);
    controller.abort(reason);
    await withTestTimeout(gatewayCleanup.promise, 1_000, "fixture did not enter cleanup");
    finishing = owner.finish(context).then(() => {
      finished = true;
    });
    await setImmediate();
    expect(finished).toBe(false);
    await expect(fs.stat(scratch!)).resolves.toBeDefined();
    expect(events).toEqual(["registered", "body", "body-settled", "client", "gateway-start"]);
    releaseCleanup.resolve();
    expect(await outcome).toBe(reason);
    await finishing;
    await expect(fs.stat(scratch!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(events).toEqual([
      "registered",
      "body",
      "body-settled",
      "client",
      "gateway-start",
      "gateway-end",
      "provider",
    ]);
  } finally {
    controller.abort(reason);
    releaseCleanup.resolve();
    await outcome;
    await finishing;
    await owner.finish(context);
  }
});

it("retains acquisition rollback failure even before a resource reaches the caller", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-test-rollback-owner-"));
  const resource = createVitestResourceOwner(root);
  const failure = new Error("acquisition rollback failed");
  const events: string[] = [];
  try {
    await withEnvAsync({ TMPDIR: root, TEMP: root, TMP: root }, async () => {
      const owner = testOwner(new AbortController().signal, events);
      const run = runQaGatewayTestFixture(
        owner.context,
        async ({ verifyCleanup }) => {
          await verifyCleanup(async () => {
            events.push("rollback");
            throw failure;
          });
        },
        () => {
          events.push("final-cleanup");
        },
      );
      await expect(run).rejects.toBe(failure);
      await expect(owner.finish(context)).rejects.toMatchObject({
        errors: expect.arrayContaining([failure]),
      });
      expect(events).toEqual(["registered", "rollback", "final-cleanup"]);
      expect(() => resource.assertReleased()).toThrow("Unreleased Vitest resource claim");
    });
  } finally {
    // Every promise above is settled; only this deliberately failed synthetic receipt remains.
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("preserves successful values and refuses an already-cancelled body", async (context) => {
  const controller = new AbortController();
  const owner = testOwner(controller.signal);
  await expect(runQaGatewayTestFixture(owner.context, async () => 42)).resolves.toBe(42);
  await owner.finish(context);
  const reason = new Error("cancelled before body admission");
  controller.abort(reason);
  let entered = false;
  const cancelledOwner = testOwner(controller.signal);
  await expect(
    runQaGatewayTestFixture(cancelledOwner.context, async () => {
      entered = true;
    }),
  ).rejects.toBe(reason);
  expect(entered).toBe(false);
  await cancelledOwner.finish(context);
});
