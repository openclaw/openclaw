// Marketplace documents and plugin HTTP routes share only their path prefix.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  AUTH_NONE,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";

async function sendGatewayRequest(
  server: Parameters<typeof dispatchRequest>[0],
  options: Parameters<typeof createRequest>[0],
) {
  const { res, getBody } = createResponse();
  await dispatchRequest(server, createRequest(options), res);
  return { res, getBody };
}

async function withMarkedControlUiRoot(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-marketplace-routing-"));
  try {
    await fs.writeFile(path.join(root, "index.html"), "<html>spa fallback</html>\n");
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

it("serves marketplace browser reads while preserving plugin HTTP boundaries", async () => {
  await withMarkedControlUiRoot(async (controlUiRoot) => {
    await withGatewayServer({
      prefix: "plugin-marketplace-root-control-ui",
      resolvedAuth: AUTH_NONE,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "",
        controlUiRoot: { kind: "resolved", path: controlUiRoot },
        handlePluginRequest: async (req, res) => {
          if (req.url !== "/plugins/webhook") {
            return false;
          }
          res.statusCode = 202;
          res.end("plugin response");
          return true;
        },
        shouldEnforcePluginGatewayAuth: () => false,
        isStartupPluginRuntimeReady: () => true,
      },
      run: async (server) => {
        for (const method of ["GET", "HEAD"]) {
          const { res, getBody } = await sendGatewayRequest(server, {
            path: "/plugins",
            method,
            headers: { accept: "text/html" },
          });
          expect(res.statusCode, method).toBe(200);
          if (method === "GET") {
            expect(getBody()).toContain("spa fallback");
          } else {
            expect(getBody()).toBe("");
          }
        }
        for (const request of [
          { path: "/plugins", method: "GET", headers: { accept: "application/json" } },
          { path: "/plugins", method: "GET", headers: { accept: "text/html;q=0" } },
          { path: "/plugins", method: "POST", headers: { accept: "text/html" } },
          { path: "/plugins/unclaimed", method: "GET", headers: { accept: "text/html" } },
        ]) {
          const { res, getBody } = await sendGatewayRequest(server, request);
          expect(res.statusCode, JSON.stringify(request)).toBe(404);
          expect(getBody()).toBe("Not Found");
        }
        const plugin = await sendGatewayRequest(server, {
          path: "/plugins/webhook",
          method: "GET",
          headers: { accept: "text/html" },
        });
        expect(plugin.res.statusCode).toBe(202);
        expect(plugin.getBody()).toBe("plugin response");
      },
    });
  });
});
