import http from "node:http";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { matrixPlugin } from "../extensions/matrix/api.js";
import { MatrixClient } from "../extensions/matrix/src/matrix/sdk.js";
import { sendMessageMatrix } from "../extensions/matrix/src/matrix/send.js";
import { installMatrixTestRuntime } from "../extensions/matrix/src/test-runtime.js";
import type { OpenClawConfig } from "../src/config/config.js";
import { asRuntimeConfig } from "../src/config/materialize.js";
import { getDeliveryQueueEntryStatus } from "../src/infra/delivery-queue-sqlite.js";
import { createCommandCronDeliveryCustody } from "../src/infra/outbound/delivery-completion.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../src/infra/outbound/delivery-queue-media-staging.js";
import {
  recoverPendingDeliveries,
  type DeliverFn,
} from "../src/infra/outbound/delivery-queue-recovery.js";
import { enqueueDeliveryOnce } from "../src/infra/outbound/delivery-queue-storage.js";
import { createRecoveryLog } from "../src/infra/outbound/delivery-queue.test-helpers.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createRunningTaskRunCore } from "../src/tasks/task-executor.js";
import { getTaskById } from "../src/tasks/task-registry.js";
import {
  configureTaskRegistryRuntime,
  getTaskRegistryStore,
} from "../src/tasks/task-registry.store.js";
import { resetTaskRegistryForTests } from "../src/tasks/task-runtime.test-helpers.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { createInMemoryTaskRegistryStore } from "../src/test-utils/task-registry-store.js";
import { createDeferred } from "./helpers/promise.js";

let deliverOutboundPayloads: typeof import("../src/infra/outbound/deliver.js").deliverOutboundPayloads;

function respondJson(response: http.ServerResponse, body: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

describe("command cron recovery through the Matrix transport client", () => {
  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("../src/infra/outbound/deliver.js"));
  });

  afterEach(() => {
    resetTaskRegistryForTests({ persist: false });
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("settles the exact recovered task only after the homeserver returns an event id", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "cron-matrix-transport-recovery-" },
      async (state) => {
        const roomId = "!recovery:example.org";
        const eventId = "$recovered-event";
        const requests: Array<{ method: string; path: string }> = [];
        const serverErrors: unknown[] = [];
        const sendReachedHomeserver = createDeferred();
        const releaseHomeserverAck = createDeferred();
        const server = http.createServer((request, response) => {
          void (async () => {
            const path = decodeURIComponent(
              new URL(request.url ?? "/", "http://localhost").pathname,
            );
            requests.push({ method: request.method ?? "", path });
            if (request.method === "GET" && path.endsWith("/state/m.room.encryption/")) {
              respondJson(response, { errcode: "M_NOT_FOUND", error: "unencrypted room" }, 404);
              return;
            }
            if (request.method === "GET" && path === "/_matrix/client/v3/account/whoami") {
              respondJson(response, {
                user_id: "@recovery-bot:example.org",
                device_id: "RECOVERY",
              });
              return;
            }
            if (
              request.method === "PUT" &&
              path.includes(`/rooms/${roomId}/send/m.room.message/`)
            ) {
              request.resume();
              sendReachedHomeserver.resolve();
              await releaseHomeserverAck.promise;
              respondJson(response, { event_id: eventId });
              return;
            }
            throw new Error(`unexpected Matrix fixture request: ${request.method} ${path}`);
          })().catch((error: unknown) => {
            serverErrors.push(error);
            if (!response.writableEnded) {
              respondJson(
                response,
                { errcode: "M_UNRECOGNIZED", error: "unexpected request" },
                400,
              );
            }
          });
        });

        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("missing Matrix loopback fixture address");
        }
        const client = new MatrixClient(`http://127.0.0.1:${address.port}`, "fixture-token", {
          userId: "@recovery-bot:example.org",
          deviceId: "RECOVERY",
          encryption: false,
          autoBootstrapCrypto: false,
          ssrfPolicy: { allowPrivateNetwork: true },
        });

        try {
          installMatrixTestRuntime({ stateDir: state.stateDir });
          const taskStore = createInMemoryTaskRegistryStore();
          resetTaskRegistryForTests({ persist: false });
          configureTaskRegistryRuntime({ store: taskStore });
          setActivePluginRegistry(
            createTestRegistry([
              {
                pluginId: "matrix",
                source: "bundled",
                origin: "bundled",
                plugin: matrixPlugin,
              },
            ]),
          );

          const unrelatedRunId = "cron:unrelated-pending-task:999:receipt";
          const unrelatedTask = createRunningTaskRunCore({
            runtime: "cron",
            sourceId: "unrelated-pending-task",
            ownerKey: "",
            scopeKind: "system",
            agentId: "main",
            runId: unrelatedRunId,
            task: "remain pending during Matrix recovery",
            deliveryStatus: "pending",
            notifyPolicy: "silent",
            startedAt: 999,
          })!;
          const runId = "cron:matrix-transport-recovery:1000:receipt";
          const task = createRunningTaskRunCore({
            runtime: "cron",
            sourceId: "matrix-transport-recovery",
            ownerKey: "",
            scopeKind: "system",
            agentId: "main",
            runId,
            task: "recover through Matrix transport",
            deliveryStatus: "pending",
            notifyPolicy: "silent",
            startedAt: 1_000,
          })!;
          const custody = createCommandCronDeliveryCustody({ taskId: task.taskId, runId });
          await enqueueDeliveryOnce(
            {
              channel: "matrix",
              to: roomId,
              payloads: [{ text: "recovered over Matrix transport" }],
              queuePolicy: "required",
              deliveryCompletion: custody.deliveryCompletion,
              completionRetention: custody.completionRetention,
            },
            custody.deliveryIntentId,
            state.stateDir,
          );

          // Simulate the process boundary: memory is cleared, the durable task store remains.
          resetTaskRegistryForTests({ persist: false });
          configureTaskRegistryRuntime({ store: taskStore });
          const cfg = asRuntimeConfig({} as OpenClawConfig);
          const matrixTransport = (
            to: string,
            text: string | undefined,
            options: Parameters<typeof sendMessageMatrix>[2],
          ) => sendMessageMatrix(to, text, { ...options, client });
          const deliver: DeliverFn = (params) =>
            deliverOutboundPayloads({ ...params, cfg, deps: { matrix: matrixTransport } });

          const recovery = recoverPendingDeliveries({
            cfg,
            deliver,
            log: createRecoveryLog(),
            stateDir: state.stateDir,
          });

          await sendReachedHomeserver.promise;
          expect(getTaskById(task.taskId)).toMatchObject({
            runId,
            deliveryStatus: "pending",
          });
          expect(getTaskById(unrelatedTask.taskId)).toMatchObject({
            runId: unrelatedRunId,
            deliveryStatus: "pending",
          });
          expect(
            getDeliveryQueueEntryStatus(
              OUTBOUND_DELIVERY_QUEUE_NAME,
              custody.deliveryIntentId,
              state.stateDir,
            ),
          ).toBe("pending");

          releaseHomeserverAck.resolve();
          await recovery;

          expect(serverErrors).toEqual([]);
          expect(requests).toEqual(
            expect.arrayContaining([
              { method: "GET", path: "/_matrix/client/v3/account/whoami" },
              expect.objectContaining({
                method: "PUT",
                path: expect.stringContaining(`/rooms/${roomId}/send/m.room.message/`),
              }),
            ]),
          );
          expect(getTaskById(task.taskId)).toMatchObject({
            runId,
            deliveryStatus: "delivered",
            detail: {
              deliveryEvidence: { intentId: custody.deliveryIntentId, state: "delivered" },
            },
          });
          expect(getTaskById(unrelatedTask.taskId)).toMatchObject({
            runId: unrelatedRunId,
            deliveryStatus: "pending",
          });
          expect(
            getDeliveryQueueEntryStatus(
              OUTBOUND_DELIVERY_QUEUE_NAME,
              custody.deliveryIntentId,
              state.stateDir,
            ),
          ).toBe("completed");
          expect(getTaskRegistryStore()).toBe(taskStore);
        } finally {
          await client.stopWithoutPersist();
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          });
        }
      },
    );
  });
});
