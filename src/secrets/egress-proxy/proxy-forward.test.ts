import { once } from "node:events";
import * as http from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { Socket } from "node:net";
import { PassThrough, Writable, type Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveSecretSentinel, sealSecretSentinel } from "../sentinel.js";
import { createSecretEgressBodyBudget, forwardSecretEgressRequest } from "./proxy-forward.js";

vi.mock("node:https", { spy: true });

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

function forwarding(
  request = new http.IncomingMessage(new Socket()),
  response = new http.ServerResponse(request),
) {
  request.on("error", () => {});
  const agent = new Agent();
  const resources: Array<Readable | Writable> = [];
  cleanups.push(() =>
    [...resources, request, response, agent].forEach((resource) => resource.destroy()),
  );
  return {
    request,
    response,
    resources,
    host: "localhost",
    upstreamTlsAgent: agent,
    prepareRequest: () => ({
      target: new URL("https://localhost:1/"),
      headers: {},
      substituted: false,
    }),
    acquireBody: createSecretEgressBodyBudget(),
    isActive: () => true,
    ownResource<T extends Readable | Writable>(resource: T) {
      resources.push(resource);
      return resource;
    },
    releaseResponse() {},
    resolveSentinel: () => undefined,
    audit() {},
  };
}

it.each([undefined, 0])(
  "releases body streams when upstream construction fails (length: %s)",
  async (length) => {
    const forward = forwarding();
    const { request, response, resources } = forward;
    request.headers = length === undefined ? {} : { "content-length": String(length) };
    request.method = "POST";
    forwardSecretEgressRequest({
      ...forward,
      // Node rejects protected values containing newlines before opening a socket.
      prepareRequest: () => ({
        target: new URL("https://localhost:1/"),
        headers: { "x-synthetic": "invalid\nheader" },
        substituted: true,
      }),
      ownResource<T extends Readable | Writable>(resource: T) {
        forward.ownResource(resource);
        resource.on("error", () => resource.destroy());
        return resource;
      },
    });
    request.push(null);
    await setImmediate();
    response.emit("close");
    await setImmediate();
    expect(response.statusCode).toBe(502);
    expect(resources.every((resource) => resource.destroyed)).toBe(true);
  },
);

it.each([
  ["run revocation", "drain"],
  ["run revocation", "next turn"],
  ["client disconnect", "drain"],
  ["client disconnect", "next turn"],
] as const)("stops buffered submission after %s while waiting for %s", async (cause, wait) => {
  const secret = "synthetic-buffered-secret";
  const marker = sealSecretSentinel(secret, { label: "buffered-cancellation" });
  const body = Buffer.from("x".repeat(128 * 1024) + marker + "tail");
  const forward = forwarding();
  const { request, response } = forward;
  request.headers = { "content-length": String(body.length) };
  request.method = "POST";
  const submitted: Buffer[] = [];
  let completeWrite: (error?: Error | null) => void = () => {};
  const started = createDeferredCore();
  // Real Writable backpressure avoids platform socket-buffer timing.
  const upstream = new Writable({
    highWaterMark: wait === "drain" ? 1 : body.length + 1,
    write(chunk: Buffer, _encoding, callback) {
      submitted.push(Buffer.from(chunk));
      completeWrite = callback;
      started.resolve();
    },
  });
  vi.mocked(httpsRequest).mockReturnValueOnce(upstream as unknown as http.ClientRequest);
  const releaseBody = vi.fn();
  const audit = vi.fn();
  let active = true;
  forwardSecretEgressRequest({
    ...forward,
    acquireBody: () => releaseBody,
    isActive: () => active,
    resolveSentinel: resolveSecretSentinel,
    audit,
  });
  request.push(body);
  request.push(null);
  await started.promise;
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
  expect(upstream).toMatchObject({ destroyed: true, writableEnded: false });
  expect(releaseBody).toHaveBeenCalledOnce();
  expect(audit).not.toHaveBeenCalled();
});

// A later-tick upstream head must not throw outside the forwarder's try block.
it("closes a rejected bodyless head instead of framing a 502 body", async () => {
  vi.mocked(httpsRequest).mockImplementationOnce(((...args: unknown[]) => {
    const callback = args.find((entry) => typeof entry === "function") as (
      message: http.IncomingMessage,
    ) => void;
    const upstreamResponse = new http.IncomingMessage(new Socket());
    upstreamResponse.statusCode = 304;
    upstreamResponse.headers = { trailer: "Expires" };
    upstreamResponse.on("error", () => {});
    process.nextTick(() => {
      callback(upstreamResponse);
      upstreamResponse.push(null);
    });
    return new PassThrough() as unknown as http.ClientRequest;
  }) as never);
  const server = http.createServer((request, response) =>
    forwardSecretEgressRequest(forwarding(request, response)),
  );
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const { port } = server.address() as AddressInfo;
  // Rejection proves no head reached the client; Vitest catches uncaught callback errors.
  await expect(
    once(http.get({ host: "127.0.0.1", port, agent: false }), "response"),
  ).rejects.toMatchObject({ code: "ECONNRESET" });
  await setImmediate();
});
