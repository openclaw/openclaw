import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";

export function createTestGatewayHttpServer(
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
) {
  const server = createServer((req, res) => {
    void handle(req, res)
      .then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end("not found");
        }
      })
      .catch((error: unknown) => {
        res.statusCode = 500;
        res.end(String(error));
      });
  });
  return {
    listen: async () => Number(new URL(await listenLoopback(server)).port),
    close: () => closeHttpServer(server),
  };
}
