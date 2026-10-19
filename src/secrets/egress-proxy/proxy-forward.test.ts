import {
  createServer,
  request as httpRequest,
  IncomingMessage,
  ServerResponse,
  type ClientRequest,
} from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { Socket } from "node:net";
import { PassThrough, Writable, type Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { resolveSecretSentinel, sealSecretSentinel } from "../sentinel.js";
import { createSecretEgressBodyBudget, forwardSecretEgressRequest } from "./proxy-forward.js";

vi.mock("node:https", { spy: true });

describe("secret egress forwarding resource ownership", () => {
  it.each([undefined, 0])(
    "releases body streams when upstream construction fails (length: %s)",
    async (length) => {
      const request = new IncomingMessage(new Socket());
      request.headers = length === undefined ? {} : { "content-length": String(length) };
      request.method = "POST";
      request.on("error", () => {});
      const response = new ServerResponse(request);
      const agent = new Agent();
      const resources: Array<Readable | Writable> = [];
      try {
        forwardSecretEgressRequest({
          request,
          response,
          host: "localhost",
          upstreamTlsAgent: agent,
          // A protected value can contain newlines. Node refuses this header
          // synchronously, before DNS, TLS or any upstream socket is opened.
          prepareRequest: () => ({
            target: new URL("https://localhost:1/"),
            headers: { "x-synthetic": "invalid\nheader" },
            substituted: true,
          }),
          acquireBody: createSecretEgressBodyBudget(),
          isActive: () => true,
          ownResource: (resource) => {
            resources.push(resource);
            resource.on("error", () => resource.destroy());
            return resource;
          },
          releaseResponse() {},
          resolveSentinel() {
            return undefined;
          },
          audit() {},
        });
        request.push(null);
        await setImmediate();
        response.emit("close");
        await setImmediate();
        expect(response.statusCode).toBe(502);
        expect(resources.every((resource) => resource.destroyed)).toBe(true);
      } finally {
        for (const resource of resources) {
          resource.destroy();
        }
        request.destroy();
        response.destroy();
        agent.destroy();
      }
    },
  );

  it.each([
    ["run revocation", "drain"],
    ["run revocation", "next turn"],
    ["client disconnect", "drain"],
    ["client disconnect", "next turn"],
  ] as const)("stops buffered submission after %s while waiting for %s", async (cause, wait) => {
    const secret = "synthetic-buffered-secret";
    const body = Buffer.concat([
      Buffer.alloc(128 * 1024, 120),
      Buffer.from(sealSecretSentinel(secret, { label: "buffered-cancellation" }) + "tail"),
    ]);
    const request = new IncomingMessage(new Socket());
    request.headers = { "content-length": String(body.length) };
    request.method = "POST";
    request.on("error", () => {});
    const response = new ServerResponse(request);
    const agent = new Agent();
    const resources: Array<Readable | Writable> = [];
    const submitted: Buffer[] = [];
    let completeWrite: (error?: Error | null) => void = () => {};
    let firstWrite: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      firstWrite = resolve;
    });
    // Real Writable backpressure controls transport admission without relying on
    // platform socket buffers or adding a test-only production hook.
    const upstream = new Writable({
      highWaterMark: wait === "drain" ? 1 : body.length + 1,
      write(chunk: Buffer, _encoding, callback) {
        submitted.push(Buffer.from(chunk));
        completeWrite = callback;
        firstWrite();
      },
    });
    vi.mocked(httpsRequest).mockReturnValueOnce(upstream as unknown as ClientRequest);
    const releaseBody = vi.fn();
    const audit = vi.fn();
    let active = true;
    try {
      forwardSecretEgressRequest({
        request,
        response,
        host: "localhost",
        upstreamTlsAgent: agent,
        prepareRequest: () => ({
          target: new URL("https://localhost:1/"),
          headers: {},
          substituted: false,
        }),
        acquireBody: () => releaseBody,
        isActive: () => active,
        ownResource: (resource) => {
          resources.push(resource);
          return resource;
        },
        releaseResponse() {},
        resolveSentinel: resolveSecretSentinel,
        audit,
      });
      request.push(body);
      request.push(null);
      await started;
      expect(releaseBody).not.toHaveBeenCalled();
      if (cause === "client disconnect") {
        response.emit("close");
      } else {
        active = false;
      }
      completeWrite();
      await setImmediate();
      await setImmediate();
      const sent = Buffer.concat(submitted);
      expect(sent.length).toBeLessThan(body.length);
      expect(sent.includes(secret)).toBe(false);
      expect(sent.includes("tail")).toBe(false);
      expect(upstream.destroyed).toBe(true);
      expect(upstream.writableEnded).toBe(false);
      expect(releaseBody).toHaveBeenCalledOnce();
      expect(audit).not.toHaveBeenCalled();
    } finally {
      for (const resource of resources) {
        resource.destroy();
      }
      request.destroy();
      response.destroy();
      agent.destroy();
    }
  });
});

describe("secret egress forwarded response heads", () => {
  // Serves one real loopback request through the proxy forwarder. The upstream
  // response is emitted on a later tick, like the real client, so a throw from
  // writeHead would escape instead of landing in the forwarder's own try block.
  it("closes a rejected bodyless head instead of framing a 502 body", async () => {
    const uncaught: unknown[] = [];
    let failClient: (error: unknown) => void = () => {};
    const onUncaught = (error: unknown) => {
      uncaught.push(error);
      failClient(error);
    };
    const resources: Array<Readable | Writable> = [];
    const agent = new Agent();
    vi.mocked(httpsRequest).mockImplementationOnce(((...args: unknown[]) => {
      const callback = args.find((entry) => typeof entry === "function") as (
        message: IncomingMessage,
      ) => void;
      const upstreamResponse = new IncomingMessage(new Socket());
      upstreamResponse.statusCode = 304;
      upstreamResponse.headers = { trailer: "Expires" };
      upstreamResponse.on("error", () => {});
      process.nextTick(() => {
        callback(upstreamResponse);
        if (!upstreamResponse.destroyed) {
          upstreamResponse.push("file");
          upstreamResponse.push(null);
        }
      });
      return new PassThrough() as unknown as ClientRequest;
    }) as never);
    const server = createServer((request, response) => {
      forwardSecretEgressRequest({
        request,
        response,
        host: "localhost",
        upstreamTlsAgent: agent,
        prepareRequest: () => ({
          target: new URL("https://localhost:1/"),
          headers: {},
          substituted: false,
        }),
        acquireBody: createSecretEgressBodyBudget(),
        isActive: () => true,
        ownResource: (resource) => {
          resources.push(resource);
          return resource;
        },
        releaseResponse() {},
        resolveSentinel() {
          return undefined;
        },
        audit() {},
      });
    });
    process.on("uncaughtException", onUncaught);
    try {
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const { port } = server.address() as AddressInfo;
      const result = await new Promise<{
        status?: number;
        clientError?: NodeJS.ErrnoException;
      }>((resolve, reject) => {
        failClient = reject;
        httpRequest({ host: "127.0.0.1", port, path: "/", agent: false }, (response) => {
          response.resume();
          resolve({ status: response.statusCode });
          response.on("error", (clientError) =>
            resolve({ status: response.statusCode, clientError }),
          );
        })
          .on("error", (clientError) => resolve({ clientError }))
          .end();
      });
      await setImmediate();
      expect(uncaught).toEqual([]);
      expect(result.status).toBeUndefined();
      expect(result.clientError?.code).toBe("ECONNRESET");
    } finally {
      process.off("uncaughtException", onUncaught);
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      for (const resource of resources) {
        resource.destroy();
      }
      agent.destroy();
    }
  });
});
