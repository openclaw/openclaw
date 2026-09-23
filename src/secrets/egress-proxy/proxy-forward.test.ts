import { IncomingMessage, ServerResponse, type ClientRequest } from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import { Socket } from "node:net";
import { Writable, type Readable } from "node:stream";
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
    ["proxy stop", "drain"],
    ["proxy stop", "next turn"],
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
        if (cause === "proxy stop") {
          for (const resource of resources) {
            resource.destroy();
          }
        }
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
