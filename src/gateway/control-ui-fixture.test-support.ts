import { createServer } from "node:http";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { handleControlUiHttpRequest } from "./control-ui.js";

/** Real HTTP with one owner for listener, port claim, and teardown. */
export async function startControlUiFixture(
  options: NonNullable<Parameters<typeof handleControlUiHttpRequest>[2]>,
) {
  const fixture = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((req, res) => {
        void handleControlUiHttpRequest(req, res, options)
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
