import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import * as resource from "../../scripts/e2e/kitchen-sink-rpc-walk.mts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const runtime = {
  runner: {
    command: process.execPath,
    baseArgs: [fileURLToPath(new URL("./fixtures/gateway-resource-host.mjs", import.meta.url))],
  },
  buildInfo: { commit: "a".repeat(40), version: "fixture", buildId: "fixture-build" },
};

type ResourceOptions = Parameters<typeof resource.runResourceGatewayCase>[0];
async function runCase(prepare: ResourceOptions["prepare"], run: ResourceOptions["run"]) {
  const result: resource.GatewayResourceCase = { name: "fixture", status: "blocked", phases: [] };
  await resource.runResourceGatewayCase({
    result,
    runtime,
    run,
    prepare: async (context) => {
      roots.push(context.root);
      await prepare(context);
    },
  });
  return result;
}

const unsupportedHost =
  process.platform !== "linux" || typeof process.threadCpuUsage !== "function";
it.skipIf(unsupportedHost).each([
  [false, "0", "0", []],
  [true, "0", "0", ["fixture assertion failed"]],
  [false, "1", "0", ["did not exit cleanly"]],
  [false, "0", "1", ["fixture service stop failed"]],
  [true, "1", "0", ["fixture assertion failed", "did not exit cleanly"]],
] as const)(
  "joins the host and retains only failed state: %s/%s/%s",
  async (workloadFails, exitCode, stopError, errors) => {
    const succeeds = errors.length === 0;
    const receipt = await runCase(
      async ({ env }) => {
        expect(env.OPENCLAW_KITCHEN_SINK_PERSONALITY).toBeUndefined();
        env.FIXTURE_EXIT_CODE = exitCode;
        env.FIXTURE_STOP_ERROR = stopError;
      },
      async ({ port, measure }) => {
        if (succeeds) {
          await measure("work", 2, async () => {
            const response = await fetch(`http://127.0.0.1:${port}/work`);
            expect(await response.json()).toEqual({ completed: true });
          });
          return;
        }
        await measure("completed", 1, async () => {});
        if (workloadFails) {
          await measure("failed", 1, async () => {
            throw new Error("fixture assertion failed");
          });
        }
      },
    );
    expect(existsSync(roots[0]!)).toBe(!succeeds);
    expect(receipt.status).toBe(succeeds ? "exercised" : "failed");
    expect(receipt.shutdown).toMatchObject({ exited: true, exitCode: Number(exitCode) });
    if (succeeds) {
      expect(receipt.phases.map(({ name }) => name)).toEqual(["startup", "work"]);
      expect(receipt.phases[1]?.operations).toEqual({ attempted: 2, completed: 2, failed: 0 });
      expect(receipt.phases[1]?.before.pid).toBe(receipt.phases[1]?.after?.pid);
      expect(receipt.shutdown?.signal).toBeNull();
      expect(receipt.host).toMatchObject(runtime.buildInfo);
      return;
    }
    expect(receipt.phases[1]?.operations.completed).toBe(1);
    for (const error of errors) {
      expect(receipt.error).toContain(error);
    }
    if (workloadFails) {
      expect(receipt.phases[2]?.operations).toEqual({ attempted: 1, completed: 0, failed: 1 });
    }
  },
);

it.skipIf(unsupportedHost)(
  "rejects a mismatched archive before invoking the installer",
  async () => {
    let invocations = "";
    const receipt = await runCase(
      async ({ root, env, installArchive }) => {
        const archive = path.join(root, "fixture.tgz");
        invocations = path.join(root, "invocations");
        env.FIXTURE_INVOCATIONS = invocations;
        writeFileSync(archive, "mismatched fixture");
        await installArchive(archive, "0".repeat(64));
      },
      async () => {
        throw new Error("work must not run");
      },
    );
    expect(receipt).toMatchObject({ status: "failed", fixtures: [], phases: [] });
    expect(receipt.error).toContain("matching its SHA-256");
    expect(existsSync(invocations)).toBe(false);
    expect(receipt.shutdown).toBeUndefined();
    expect(existsSync(roots[0]!)).toBe(true);
  },
);
