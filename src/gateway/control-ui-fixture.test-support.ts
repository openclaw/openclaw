import { createServer, request, type IncomingMessage, type RequestOptions } from "node:http";
import { buffer } from "node:stream/consumers";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import type { handleControlUiHttpRequest } from "./control-ui.js";

export async function readHttp(url: string, options: RequestOptions = {}) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    request(url, { agent: false, ...options }, resolve)
      .on("error", reject)
      .end();
  });
  const body = await buffer(response);
  const text = new TextDecoder().decode(body);
  return {
    status: response.statusCode,
    headers: { etag: null, "last-modified": null, "content-length": null, ...response.headers },
    body,
    text,
    byteLength: body.byteLength,
    json: (): unknown => JSON.parse(text),
  };
}

/** Real HTTP with one owner for listener, port claim, and teardown. */
export async function startControlUiFixture(
  options: NonNullable<Parameters<typeof handleControlUiHttpRequest>[2]>,
) {
  const { handleControlUiHttpRequest: handle } = await import("./control-ui.js");
  const fixture = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((req, res) => {
        void handle(req, res, options)
          .then((handled) => {
            if (!handled) {
              res.statusCode = 404;
              res.end();
            }
          })
          .catch((error: unknown) => {
            res.statusCode = 500;
            res.end(String(error));
          });
      }),
  });
  const close = async () => {
    fixture.listener.closeAllConnections();
    try {
      await fixture.releaseListener();
    } finally {
      await fixture.claim.release();
    }
  };
  return { origin: `http://127.0.0.1:${fixture.claim.port}`, close, [Symbol.asyncDispose]: close };
}
