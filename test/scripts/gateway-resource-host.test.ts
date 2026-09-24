import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  runResourceGatewayCase,
  type GatewayResourceCase,
} from "../../scripts/e2e/kitchen-sink-rpc-walk.mts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const runtime = {
  runner: {
    command: process.execPath,
    baseArgs: [fileURLToPath(new URL("./fixtures/gateway-resource-host.mjs", import.meta.url))],
  },
  buildInfo: { commit: "a".repeat(40), version: "fixture", buildId: "fixture-build" },
};

function result(): GatewayResourceCase {
  return { name: "fixture", status: "blocked", phases: [] };
}

describe.skipIf(process.platform !== "linux" || typeof process.threadCpuUsage !== "function")(
  "shared resource Gateway lifecycle",
  () => {
    it("records actual child samples and joins a successful workload before removing state", async () => {
      const receipt = result();
      let root = "";
      await runResourceGatewayCase({
        result: receipt,
        runtime,
        prepare: async (context) => {
          root = context.root;
          roots.push(root);
          expect(context.env.OPENCLAW_KITCHEN_SINK_PERSONALITY).toBeUndefined();
        },
        run: async ({ port, measure }) => {
          const url = new URL("http://127.0.0.1/work");
          url.port = String(port);
          await measure("work", 2, async () => {
            const response = await fetch(url);
            expect(await response.json()).toEqual({ completed: true });
          });
        },
      });
      expect(receipt.status).toBe("exercised");
      expect(receipt.phases.map(({ name }) => name)).toEqual(["startup", "work"]);
      expect(receipt.phases[1]?.operations).toEqual({ attempted: 2, completed: 2, failed: 0 });
      expect(receipt.phases[1]?.before.pid).toBe(receipt.phases[1]?.after?.pid);
      expect(receipt.shutdown).toMatchObject({ exited: true, exitCode: 0, signal: null });
      expect(receipt.host).toMatchObject(runtime.buildInfo);
      expect(existsSync(root)).toBe(false);
    });

    it("retains preparation failure without starting a child or running work", async () => {
      const receipt = result();
      await runResourceGatewayCase({
        result: receipt,
        runtime,
        prepare: async ({ root }) => {
          roots.push(root);
          throw new Error("fixture preparation failed");
        },
        run: async () => {
          throw new Error("work must not run");
        },
      });
      expect(receipt).toMatchObject({
        status: "failed",
        error: "fixture preparation failed",
        phases: [],
      });
      expect(receipt.shutdown).toBeUndefined();
      expect(existsSync(roots[0]!)).toBe(true);
    });

    it.each([
      { workloadFails: true, exitCode: "0", stopError: "0" },
      { workloadFails: false, exitCode: "1", stopError: "0" },
      { workloadFails: false, exitCode: "0", stopError: "1" },
      { workloadFails: true, exitCode: "1", stopError: "0" },
    ])(
      "preserves work and invalidates failure $workloadFails/$exitCode/$stopError",
      async ({ workloadFails, exitCode, stopError }) => {
        const receipt = result();
        await runResourceGatewayCase({
          result: receipt,
          runtime,
          prepare: async ({ root, env }) => {
            roots.push(root);
            env.FIXTURE_EXIT_CODE = exitCode;
            env.FIXTURE_STOP_ERROR = stopError;
          },
          run: async ({ measure }) => {
            await measure("completed", 1, async () => {});
            if (workloadFails) {
              await measure("failed", 1, async () => {
                throw new Error("fixture assertion failed");
              });
            }
          },
        });
        expect(receipt.status).toBe("failed");
        expect(receipt.phases[1]?.operations.completed).toBe(1);
        expect(receipt.shutdown).toMatchObject({ exited: true, exitCode: Number(exitCode) });
        if (workloadFails) {
          expect(receipt.error).toContain("fixture assertion failed");
          expect(receipt.phases[2]?.operations).toEqual({ attempted: 1, completed: 0, failed: 1 });
        }
        if (exitCode === "1") {
          expect(receipt.error).toContain("did not exit cleanly");
        }
        if (stopError === "1") {
          expect(receipt.error).toContain("fixture service stop failed");
        }
        expect(existsSync(roots[0]!)).toBe(true);
      },
    );

    it("rejects a mismatched archive before invoking the installer", async () => {
      const receipt = result();
      let invocations = "";
      await runResourceGatewayCase({
        result: receipt,
        runtime,
        prepare: async ({ root, env, installArchive }) => {
          roots.push(root);
          const archive = path.join(root, "fixture.tgz");
          invocations = path.join(root, "invocations");
          env.FIXTURE_INVOCATIONS = invocations;
          writeFileSync(archive, "mismatched fixture");
          await installArchive(archive, "0".repeat(64));
        },
        run: async () => {},
      });
      expect(receipt).toMatchObject({ status: "failed", fixtures: [], phases: [] });
      expect(receipt.error).toContain("matching its SHA-256");
      expect(existsSync(invocations)).toBe(false);
    });
  },
);
