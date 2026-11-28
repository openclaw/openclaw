import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import * as postgres from "./postgres-sync/pool.js";
import { createWorkerTaskHost } from "./worker-task-host.js";
import type { WorkerTaskContext } from "./worker-task-transport.js";

it.each(["warm", "admission", "postgres"] as const)(
  "delivers %s context ports in order without copying warm transfer lists",
  async (kind) => {
    const transport = new MessageChannel();
    const channels = Array.from(
      { length: kind === "warm" ? 0 : kind === "postgres" ? 5 : 1 },
      () => new MessageChannel(),
    );
    const context: WorkerTaskContext = {
      deletedAgentDatabaseFences: [],
      databaseAdmissionPort: channels[0]?.port1,
      postgresPool:
        kind === "postgres"
          ? {
              allocation: new SharedArrayBuffer(4),
              services: channels.slice(1).map(({ port1 }) => ({
                port: port1,
                signal: new SharedArrayBuffer(8),
              })),
            }
          : undefined,
    };
    const prepare = vi.spyOn(postgres, "postgresPoolTransferList");
    let received: WorkerTaskContext | undefined;
    try {
      const transfers = createWorkerTaskHost().taskContextTransferList!(context);
      if (kind === "warm") {
        expect(transfers === prepare.mock.results[0]?.value).toBe(true);
      }
      expect(transfers).toEqual(channels.map(({ port1 }) => port1));
      expect(context.postgresPool?.services.length ?? 0).toBe(kind === "postgres" ? 4 : 0);
      const delivery = once(transport.port2, "message");
      transport.port1.postMessage(context, [...transfers]);
      [received] = await delivery;
      const ports = [
        received?.databaseAdmissionPort,
        ...(received?.postgresPool?.services.map(({ port }) => port) ?? []),
      ].filter((port) => port !== undefined);
      await Promise.all(
        ports.map(async (port, index) => {
          const reply = once(channels[index]!.port2, "message");
          port.postMessage(index);
          expect(await reply).toEqual([index]);
        }),
      );
    } finally {
      prepare.mockRestore();
      received?.databaseAdmissionPort?.close();
      received?.postgresPool?.services.forEach(({ port }) => port.close());
      transport.port1.close();
      transport.port2.close();
      channels.forEach(({ port1, port2 }) => {
        port1.close();
        port2.close();
      });
    }
  },
);
