import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";

/** Own the provider's in-flight handlers until shutdown, including aborted test requests. */
export function createTrackedProvider(
  handle: (raw: string, response: ServerResponse, request: IncomingMessage) => void | Promise<void>,
  options: {
    signal?: AbortSignal;
    ignoreError?: (error: unknown, request: IncomingMessage) => boolean;
  } = {},
) {
  const handlers = new Set<Promise<void>>();
  const errors: unknown[] = [];
  let closePromise: Promise<void> | undefined;
  const server = createServer((request, response) => {
    const handling = (async () => {
      options.signal?.throwIfAborted();
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        options.signal?.throwIfAborted();
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      options.signal?.throwIfAborted();
      await handle(Buffer.concat(chunks).toString("utf8"), response, request);
    })().catch((error: unknown) => {
      if (options.ignoreError?.(error, request)) {
        return;
      }
      errors.push(error);
      if (!options.signal?.aborted && !response.destroyed && !response.writableEnded) {
        response.writeHead(500).end(String(error));
      }
    });
    handlers.add(handling);
    void handling.then(
      () => handlers.delete(handling),
      (error: unknown) => {
        errors.push(error);
        handlers.delete(handling);
      },
    );
  });
  return {
    errors,
    async listen() {
      await once(server.listen(0, "127.0.0.1"), "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("mock provider did not bind");
      }
      return `http://127.0.0.1:${address.port}/v1`;
    },
    close(): Promise<void> {
      return (closePromise ??= (async () => {
        if (!server.listening) {
          return;
        }
        const closed = promisify(server.close.bind(server))();
        server.closeAllConnections();
        await runQaGatewayFixture(
          () => closed,
          async () => {
            while (handlers.size) {
              await Promise.allSettled(handlers);
            }
            if (errors.length) {
              throw new AggregateError(errors, "mock provider handlers failed");
            }
          },
        );
      })());
    },
  };
}
