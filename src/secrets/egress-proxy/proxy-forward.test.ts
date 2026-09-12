import { IncomingMessage, ServerResponse } from "node:http";
import { Agent } from "node:https";
import { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createSecretEgressBodyBudget, forwardSecretEgressRequest } from "./proxy-forward.js";

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
});
