import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getManagedChildCommandPid } from "../../scripts/lib/managed-child-process.mts";
import {
  assertManagedHandoffTestConsumer,
  createManagedHandoffTestBinding,
} from "../../test/helpers/managed-handoff-isolation.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";

describe.skipIf(process.platform !== "win32")("Windows cron process identity", () => {
  it(
    "completes a scheduled Gateway job with a durable owner identity",
    { timeout: 90_000 },
    (context) => {
      let instance: OpenClawTestInstance | undefined;
      let jobId: string | undefined;
      let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      return runQaGatewayTestFixture(
        context,
        async ({ signal, verifyCleanup, createTempDir }) => {
          const handoff = createManagedHandoffTestBinding(createTempDir("windows-cron-handoff-"));
          instance = await createOpenClawTestInstance({
            name: `windows-cron-process-identity-${process.pid}`,
            signal,
            verifyCleanup,
            gatewayCommandPrefix: [process.execPath, handoff.nodeOption],
            env: {
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
              OPENCLAW_SKIP_CRON: undefined,
              OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            },
          });
          signal.throwIfAborted();
          await instance.startGateway();
          signal.throwIfAborted();
          if (!instance.child) {
            throw new Error("Ready Gateway has no managed process owner");
          }
          assertManagedHandoffTestConsumer(
            handoff,
            getManagedChildCommandPid(instance.child),
            path.resolve("dist"),
          );
          client = await connectGatewayClient({
            url: instance.url,
            token: instance.gatewayToken,
            requestTimeoutMs: 30_000,
            signal,
            verifyCleanup,
          });
          signal.throwIfAborted();
          const job = await client.request<{ id: string }>(
            "cron.add",
            {
              name: "Windows process identity proof",
              enabled: true,
              deleteAfterRun: false,
              schedule: { kind: "at", at: new Date(Date.now() + 2_000).toISOString() },
              sessionTarget: "main",
              wakeMode: "next-heartbeat",
              payload: { kind: "systemEvent", text: "Windows process identity proof fired" },
            },
            { signal },
          );
          jobId = job.id;
          signal.throwIfAborted();

          let terminal: Record<string, unknown> | undefined;
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            signal.throwIfAborted();
            const history = await client.request<{ entries: Array<Record<string, unknown>> }>(
              "cron.runs",
              { id: job.id, limit: 1 },
              { signal },
            );
            signal.throwIfAborted();
            terminal = history.entries[0];
            if (terminal && terminal.status !== "running") {
              break;
            }
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 250);
            });
            signal.throwIfAborted();
          }

          signal.throwIfAborted();
          const database = new DatabaseSync(
            path.join(instance.stateDir, "state", "openclaw.sqlite"),
            { readOnly: true },
          );
          let receipt: Record<string, unknown> | undefined;
          try {
            receipt = database
              .prepare(
                `SELECT status, owner_pid AS ownerPid, owner_start_time AS ownerStartTime,
                    finished_at_ms AS finishedAtMs
               FROM cron_run_receipts WHERE job_id = ?
               ORDER BY started_at_ms DESC LIMIT 1`,
              )
              .get(job.id);
          } finally {
            database.close();
          }

          expect(terminal).toMatchObject({ status: "ok", completionStatus: "succeeded" });
          expect(receipt).toMatchObject({
            status: "ok",
            ownerPid: expect.any(Number),
            ownerStartTime: expect.any(Number),
            finishedAtMs: expect.any(Number),
          });
        },
        async () => {
          if (jobId && client) {
            await client.request("cron.remove", { id: jobId }).catch(() => undefined);
          }
        },
        async () => {
          if (client) {
            await disconnectGatewayClient(client);
          }
        },
        async () => {
          await instance?.cleanup();
        },
      );
    },
  );
});
