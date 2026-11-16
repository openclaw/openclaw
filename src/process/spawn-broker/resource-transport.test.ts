import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MessageChannel } from "node:worker_threads";
import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withEnv } from "../../test-utils/env.js";
import { observeMainThreadFs } from "../../test-utils/main-thread-fs-spies.test-support.js";
import { createSpawnBrokerHost } from "./host.js";
import * as resourceAuthority from "./resource-authority.js";
import { attachBrokerNativeResource } from "./resource-client.js";
import type { BrokerResourceResponse } from "./resource-protocol.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

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

it.skipIf(process.platform === "win32")(
  "creates and retires a cold native resource without main-thread synchronous metadata",
  async () => {
    const preload = path.join(temp.make("broker-private-mode-"), "umask.mjs");
    fs.writeFileSync(preload, "process.umask(0o400);");
    using observed = observeMainThreadFs();
    {
      await using fixture = withEnv(
        {
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`,
        },
        resourceFixture,
      );
      const { client, lease } = await fixture.attach(`
        export function createNativeWorkerResource() { return { close() {} }; }
      `);
      const directory = path.dirname(lease.attachment.endpoint);
      expect((await fs.promises.stat(directory)).mode & 0o777).toBe(0o700);
      await client.close();
      await lease.close();
      lease.release();
      await fixture.host.close();
      await expect(fs.promises.stat(directory)).rejects.toHaveProperty("code", "ENOENT");
    }
    expect(
      observed
        .stacks()
        .filter(
          ({ api, opensForWrite }) =>
            opensForWrite ||
            /^(?:mkdtemp|mkdir|rmdir|rm|rename|unlink|symlink|link|writeFile|appendFile|copyFile|cp|chmod|fchmod|lchmod|chown|fchown|lchown|truncate|ftruncate|utimes|futimes|lutimes)Sync$/u.test(
              api,
            ),
        ),
    ).toEqual([]);
  },
);

it.skipIf(process.platform === "win32")(
  "refuses an existing resource directory without removing its contents",
  async () => {
    const authority = resourceAuthority.createNativeResourceAuthority();
    const directory = path.dirname(authority.endpoint);
    await fs.promises.mkdir(directory, { mode: 0o700 });
    const marker = path.join(directory, "existing-owner");
    await fs.promises.writeFile(marker, "synthetic existing owner");
    const create = vi
      .spyOn(resourceAuthority, "createNativeResourceAuthority")
      .mockReturnValue(authority);
    const host = createSpawnBrokerHost({ nativeResources: true });
    try {
      await expect(host.ready()).rejects.toThrow();
      await host.close();
      expect(await fs.promises.readFile(marker, "utf8")).toBe("synthetic existing owner");
    } finally {
      create.mockRestore();
      await host.close();
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  },
);
