import { MessageChannel } from "node:worker_threads";
import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createSpawnBrokerHost } from "./host.js";
import { attachBrokerNativeResource } from "./resource-client.js";
import type { BrokerResourceResponse } from "./resource-protocol.js";

function resourceFixture() {
  const host = createSpawnBrokerHost({ nativeResources: true });
  const { port1, port2 } = new MessageChannel();
  const failure = createDeferred<Error>();
  const ownerFailures: Error[] = [];
  const clientFailures: Error[] = [];
  const responses: BrokerResourceResponse[] = [];
  let client: ReturnType<typeof attachBrokerNativeResource> | undefined;
  let lease: ReturnType<typeof host.captureNativeResource> | undefined;
  return {
    host,
    send: (value: unknown) => port2.postMessage(value),
    failure: failure.promise,
    ownerFailures,
    clientFailures,
    responses,
    async attach(
      source: string | URL,
      ownerPort = false,
      observe: (response: BrokerResourceResponse) => void = () => {},
    ) {
      await host.ready();
      lease = host.captureNativeResource(
        {
          moduleUrl:
            source instanceof URL
              ? source.href
              : `data:text/javascript,${encodeURIComponent(source)}`,
          ownerPort,
        },
        { message() {}, failed: (error) => ownerFailures.push(error) },
      );
      client = attachBrokerNativeResource(
        lease.attachment,
        port1,
        (response) => {
          responses.push(response);
          observe(response);
        },
        (error) => {
          clientFailures.push(error);
          failure.resolve(error);
        },
      );
      return { client, lease };
    },
    async [Symbol.asyncDispose]() {
      if (lease?.attachment.ownerPort) {
        try {
          lease.ownerMessage("permit-close");
        } catch {
          /* Already released. */
        }
      }
      client?.dispose();
      port1.close();
      port2.close();
      await lease?.close();
      lease?.release();
      await host.close();
    },
  };
}

it.skipIf(process.platform === "win32")(
  "loads a source SQLite resource in the compiled broker and joins its cleanup",
  async () => {
    await using fixture = resourceFixture();
    const created = createDeferred();
    const { client, lease } = await fixture.attach(
      new URL("../../infra/sqlite-readonly-native-resource.ts", import.meta.url),
      true,
      (response) => {
        if (response.type === "resource-created") {
          created.resolve();
        }
      },
    );
    expect(fixture.host.entryPath).not.toMatch(/\.[cm]?ts$/u);
    await Promise.race([
      created.promise,
      fixture.failure.then((error) => {
        throw error;
      }),
    ]);
    await client.close();
    await lease.close();
    lease.release();
    expect([fixture.ownerFailures, fixture.clientFailures]).toEqual([[], []]);
    expect(fixture.responses).toContainEqual({
      type: "resource-closed",
      id: lease.attachment.id,
      requestId: 1,
    });
  },
  20_000,
);

it.skipIf(process.platform === "win32").each([
  ["import", 'throw new Error("synthetic resource import failure");'],
  [
    "factory",
    'export function createNativeWorkerResource() { throw new Error("synthetic resource factory failure"); }',
  ],
])(
  "closes failed resource %s initialization without losing its original error",
  async (stage, source) => {
    await using fixture = resourceFixture();
    const { client, lease } = await fixture.attach(source);
    const message = `synthetic resource ${stage} failure`;
    expect((await fixture.failure).message).toContain(message);
    await client.close();
    await lease.close();
    lease.release();
    expect(fixture.ownerFailures.some((error) => error.message.includes(message))).toBe(true);
  },
  20_000,
);

it.skipIf(process.platform === "win32")(
  "keeps owner cleanup replies usable after an admitted resource operation fails",
  async () => {
    await using fixture = resourceFixture();
    const created = createDeferred();
    const { client, lease } = await fixture.attach(
      `
      export function createNativeWorkerResource(target, _input, owner) {
        let permit;
        const permitted = new Promise(resolve => { permit = resolve; });
        owner.on("message", () => permit());
        target.on("message", () => { throw new Error("synthetic resource operation failure"); });
        return { async close() { owner.postMessage("close-requested"); await permitted; } };
      }
    `,
      true,
      (response) => {
        if (response.type === "resource-created") {
          created.resolve();
        } else if (response.type === "resource-owner") {
          expect(response.value).toBe("close-requested");
          client.ownerMessage("permit-close", 1);
        }
      },
    );
    await created.promise;
    fixture.send("fail-operation");
    expect((await fixture.failure).message).toContain("synthetic resource operation failure");
    await client.close();
    await lease.close();
    lease.release();
  },
  20_000,
);

it.skipIf(process.platform === "win32")(
  "retains both disposal failures through the running native resource server and client",
  async () => {
    await using fixture = resourceFixture();
    const { client, lease } = await fixture.attach(`
      export function createNativeWorkerResource() {
        let attempts = 0;
        return { async close() {
          if (++attempts > 1) return;
          await using resource = {
            async [Symbol.asyncDispose]() { throw new Error("resource cleanup failed"); }
          };
          throw new Error("resource operation failed");
        }};
      }
    `);
    const failure: unknown = await client.close().catch((error: unknown) => error);
    const diagnostic = formatErrorMessage(failure, { redact: (text) => text });
    await client.close();
    await lease.close();
    lease.release();
    expect([fixture.ownerFailures, fixture.clientFailures]).toEqual([[], []]);
    expect(fixture.responses).toMatchObject([
      { type: "resource-ready", pid: fixture.host.pid },
      { type: "resource-created" },
      { type: "resource-close-error", requestId: 1 },
      { type: "resource-closed", requestId: 2 },
    ]);
    expect(fixture.host.pid).not.toBe(process.pid);
    expect(diagnostic).toContain("resource cleanup failed | resource operation failed");
  },
  20_000,
);
