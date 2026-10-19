import { MessageChannel } from "node:worker_threads";
import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createSpawnBrokerHost } from "./host.js";
import { attachBrokerNativeResource } from "./resource-client.js";

it.skipIf(process.platform === "win32").each([
  ["import", 'throw new Error("synthetic resource import failure");'],
  [
    "factory",
    'export function createNativeWorkerResource() { throw new Error("synthetic resource factory failure"); }',
  ],
])(
  "closes failed resource %s initialization without losing its original error",
  async (stage, source) => {
    const host = createSpawnBrokerHost({ nativeResources: true });
    const { port1, port2 } = new MessageChannel();
    const failure = createDeferred<Error>();
    const failures: Error[] = [];
    let client: ReturnType<typeof attachBrokerNativeResource> | undefined;
    let lease: ReturnType<typeof host.captureNativeResource> | undefined;
    try {
      await host.ready();
      lease = host.captureNativeResource(
        { moduleUrl: `data:text/javascript,${encodeURIComponent(source)}`, ownerPort: false },
        { message() {}, failed: (error) => failures.push(error) },
      );
      client = attachBrokerNativeResource(lease.attachment, port1, () => {}, failure.resolve);
      expect((await failure.promise).message).toContain(`synthetic resource ${stage} failure`);
      await client.close();
      await lease.close();
      lease.release();
      expect(
        failures.some((error) => error.message.includes(`synthetic resource ${stage} failure`)),
      ).toBe(true);
    } finally {
      client?.dispose();
      port1.close();
      port2.close();
      await lease?.close();
      lease?.release();
      await host.close();
    }
  },
  20_000,
);

it.skipIf(process.platform === "win32")(
  "keeps owner cleanup replies usable after an admitted resource operation fails",
  async () => {
    const moduleUrl = `data:text/javascript,${encodeURIComponent(`
      export function createNativeWorkerResource(target, _input, owner) {
        let permit;
        const permitted = new Promise(resolve => { permit = resolve; });
        owner.on("message", () => permit());
        target.on("message", () => { throw new Error("synthetic resource operation failure"); });
        return { async close() { owner.postMessage("close-requested"); await permitted; } };
      }
    `)}`;
    const host = createSpawnBrokerHost({ nativeResources: true });
    const { port1, port2 } = new MessageChannel();
    const created = createDeferred();
    const failure = createDeferred<Error>();
    let client: ReturnType<typeof attachBrokerNativeResource> | undefined;
    let lease: ReturnType<typeof host.captureNativeResource> | undefined;
    try {
      await host.ready();
      lease = host.captureNativeResource(
        { moduleUrl, ownerPort: true },
        { message() {}, failed() {} },
      );
      client = attachBrokerNativeResource(
        lease.attachment,
        port1,
        (response) => {
          if (response.type === "resource-created") {
            created.resolve();
          } else if (response.type === "resource-owner") {
            expect(response.value).toBe("close-requested");
            client!.ownerMessage("permit-close", 1);
          }
        },
        failure.resolve,
      );
      await created.promise;
      port2.postMessage("fail-operation");
      expect((await failure.promise).message).toContain("synthetic resource operation failure");
      await client.close();
      await lease.close();
      lease.release();
    } finally {
      try {
        void lease?.ownerMessage("permit-close").result.catch(() => {});
      } catch {
        // A successfully closed/released fixture needs no fallback permission.
      }
      client?.dispose();
      port1.close();
      port2.close();
      await lease?.close();
      lease?.release();
      await host.close();
    }
  },
  20_000,
);

it.skipIf(process.platform === "win32")(
  "retains both disposal failures through the running native resource server and client",
  async () => {
    // This module executes in the real broker process, not in the test's client.
    const moduleUrl = `data:text/javascript,${encodeURIComponent(`
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
    `)}`;
    const host = createSpawnBrokerHost({ nativeResources: true });
    const { port1, port2 } = new MessageChannel();
    let client: ReturnType<typeof attachBrokerNativeResource> | undefined;
    let lease: ReturnType<typeof host.captureNativeResource> | undefined;
    const failures: Error[] = [];
    const responses: { type: string; requestId?: number; separateProcess?: boolean }[] = [];
    try {
      await host.ready();
      lease = host.captureNativeResource(
        { moduleUrl, ownerPort: false },
        { message() {}, failed: (error) => failures.push(error) },
      );
      client = attachBrokerNativeResource(
        lease.attachment,
        port1,
        (response) => {
          // Project only public protocol facts; never log attachment secrets, paths, or stacks.
          responses.push({
            type: response.type,
            ...("requestId" in response ? { requestId: response.requestId } : {}),
            ...(response.type === "resource-ready"
              ? { separateProcess: response.pid === host.pid && response.pid !== process.pid }
              : {}),
          });
        },
        (error) => failures.push(error),
      );
      const failure: unknown = await client.close().catch((error: unknown) => error);
      const diagnostic = formatErrorMessage(failure, { redact: (text) => text });
      // A successful retry proves the real resource owner and transport remain usable.
      await client.close();
      await lease.close();
      lease.release();
      console.info(JSON.stringify({ responses, diagnostic, retryClosed: true }));
      expect(failures).toEqual([]);
      expect(responses).toEqual([
        { type: "resource-ready", separateProcess: true },
        { type: "resource-created" },
        { type: "resource-close-error", requestId: 1 },
        { type: "resource-closed", requestId: 2 },
      ]);
      expect(diagnostic).toContain("resource cleanup failed | resource operation failed");
    } finally {
      client?.dispose();
      port1.close();
      port2.close();
      await host.close();
    }
  },
  20_000,
);
