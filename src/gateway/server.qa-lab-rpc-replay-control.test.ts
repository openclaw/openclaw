import { createServer } from "node:http";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { expect, it } from "vitest";
import { createHttp1ProxyAgent } from "../infra/net/undici-runtime.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { requestQaReplayControl } from "./server.qa-lab-rpc-replay.test-support.js";

it("keeps fixture controls direct without changing ambient proxy routing", async () => {
  let proxyConnections = 0;
  let fixtureRequests = 0;
  const proxy = createServer();
  proxy.on("connect", (_req, socket) => {
    proxyConnections += 1;
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise<void>((resolve) => {
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  if (!address || typeof address === "string") {
    throw new Error("missing proxy address");
  }
  const previous = getGlobalDispatcher();
  const dispatcher = createHttp1ProxyAgent(`http://127.0.0.1:${address.port}`);
  setGlobalDispatcher(dispatcher);
  try {
    await withServer(
      (req, res) => {
        fixtureRequests += 1;
        if (req.headers["x-qa-fixture-token"] !== "fixture-token") {
          res.writeHead(403).end();
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          expect(req.url).toBe("/__fixture");
          expect(JSON.parse(body)).toEqual({ action: "reset" });
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ events: [{ kind: "control-received" }] }));
        });
      },
      async (baseUrl) => {
        const oldControl = () =>
          fetch(`${baseUrl}/__fixture`, {
            method: "POST",
            headers: { "x-qa-fixture-token": "fixture-token", "content-type": "application/json" },
            body: JSON.stringify({ action: "reset" }),
            signal: AbortSignal.timeout(5_000),
          });
        await expect(oldControl()).rejects.toThrow();
        expect(proxyConnections).toBe(1);
        expect(fixtureRequests).toBe(0);
        await expect(requestQaReplayControl(baseUrl, "fixture-token", "reset")).resolves.toEqual({
          events: [{ kind: "control-received" }],
        });
        expect(fixtureRequests).toBe(1);
        expect(proxyConnections).toBe(1);
        await expect(requestQaReplayControl(baseUrl, "wrong-token", "reset")).rejects.toThrow(
          "proxy control failed: 403",
        );
        expect(fixtureRequests).toBe(2);
        // Independent negative control: unrelated fetches must still reach the proxy.
        await expect(oldControl()).rejects.toThrow();
        expect(proxyConnections).toBe(2);
        expect(fixtureRequests).toBe(2);
        expect(getGlobalDispatcher()).toBe(dispatcher);
      },
    );
  } finally {
    setGlobalDispatcher(previous);
    await dispatcher.close();
    await new Promise<void>((resolve, reject) => {
      proxy.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
