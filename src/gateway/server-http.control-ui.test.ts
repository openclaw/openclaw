import fsSync from "node:fs";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { saveMediaBuffer } from "../media/store.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  AUTH_NONE,
  AUTH_TOKEN,
  sendRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";

type Server = Parameters<typeof sendRequest>[0];
type Request = Parameters<typeof sendRequest>[1];
type ServerOptions = Parameters<typeof withGatewayServer>[0];

function withUiServer({
  overrides,
  ...options
}: Omit<ServerOptions, "prefix" | "resolvedAuth"> & {
  resolvedAuth?: ServerOptions["resolvedAuth"];
}) {
  return withGatewayServer({
    prefix: "control-ui",
    resolvedAuth: AUTH_NONE,
    ...options,
    overrides: { controlUiEnabled: true, controlUiBasePath: "", ...overrides },
  });
}

function withUiRoot(run: (root: string) => Promise<void>) {
  return withTempDir("openclaw-http-ui-", async (root) => {
    await fs.writeFile(nodePath.join(root, "index.html"), "<html>synthetic UI</html>\n");
    await fs.mkdir(nodePath.join(root, "assets"));
    await fs.writeFile(nodePath.join(root, "assets", "app.js"), "// synthetic asset\n");
    await run(root);
  });
}

async function request(
  server: Server,
  path: string,
  status: number,
  options: Omit<Request, "path"> = {},
) {
  const response = await sendRequest(server, { path, ...options });
  expect(response.res.statusCode, `${options.method ?? "GET"} ${path}`).toBe(status);
  return response;
}

describe("Gateway Control UI identity", () => {
  it.each([
    { basePath: "", enabled: true },
    { basePath: "/console/", enabled: false },
  ])(
    "keeps authenticated media available at $basePath with dashboard enabled=$enabled",
    async ({ basePath, enabled }) => {
      await withUiServer({
        resolvedAuth: AUTH_TOKEN,
        overrides: { controlUiEnabled: enabled, controlUiBasePath: basePath },
        run: async (server) => {
          const base = basePath.replace(/\/$/, "");
          const media = await saveMediaBuffer(
            createSolidPngBuffer(4, 2, { r: 24, g: 64, b: 128 }),
            "image/png",
          );
          const query = new URLSearchParams({ meta: "1", source: `media://inbound/${media.id}` });
          const mediaPath = `${base}/__openclaw__/assistant-media?${query}`;
          for (const [method, path] of [
            ["GET", mediaPath],
            ["POST", `${mediaPath}&allow=1`],
          ] as const) {
            await request(server, path, 401, { method });
          }
          const metadata = await request(server, mediaPath, 200, {
            authorization: `Bearer ${AUTH_TOKEN.token}`,
          });
          expect(JSON.parse(metadata.getBody())).toMatchObject({
            available: true,
            mimeType: "image/png",
            mediaTicket: expect.any(String),
          });
          await request(server, `${base}/avatar/main?meta=1`, enabled ? 401 : 404);
          if (!enabled) {
            await request(server, `${base}/`, 404);
          }
        },
      });
    },
  );

  it("keeps the root UI POST rejection ahead of the startup fallback", async () => {
    await withUiServer({
      overrides: {
        isStartupPluginRuntimeReady: () => false,
      },
      run: async (server) => {
        const response = await request(server, "/ui", 404, { method: "POST" });
        expect(response.getBody()).toBe("Not Found");
        expect(response.setHeader).toHaveBeenCalledWith(
          "Permissions-Policy",
          "camera=(self), microphone=*, geolocation=*, clipboard-write=*",
        );
      },
    });
  });

  it.each(["", "/console/"])(
    "leaves unclaimed media writes to startup at base %j",
    async (basePath) => {
      await withUiServer({
        resolvedAuth: AUTH_TOKEN,
        overrides: {
          controlUiBasePath: basePath,
          isStartupPluginRuntimeReady: () => false,
        },
        run: async (server) => {
          const base = basePath.replace(/\/$/, "");
          for (const query of ["meta=1", "allow=1", "meta=1&allow=0"]) {
            const response = await request(
              server,
              `${base}/__openclaw__/assistant-media?${query}&source=missing.png`,
              503,
              {
                method: "POST",
              },
            );
            expect(response.getBody()).toBe("Plugin runtime is starting");
          }
        },
      });
    },
  );

  it("applies dashboard enablement to subsequent requests without replacing the listener", async () => {
    await withUiRoot(async (controlUiRoot) => {
      let enabled: boolean | undefined = false;
      await withUiServer({
        overrides: {
          controlUiEnabled: undefined,
          controlUiRoot: { kind: "resolved", path: controlUiRoot },
          getRuntimeConfig: () => ({ gateway: { controlUi: { enabled } } }),
        },
        run: async (server) => {
          for (const next of [false, true, false, undefined]) {
            enabled = next;
            for (const path of ["/", "/chat", "/assets/app.js", "/control-ui-config.json"]) {
              await request(server, path, enabled === false ? 404 : 200);
            }
            await request(server, "/healthz", 200);
          }
        },
      });
    });
  });

  it("keeps assets independent of identity reads while documents and bootstrap resolve identity", async () => {
    await withUiRoot(async (controlUiRoot) => {
      const workspace = await fs.realpath(controlUiRoot);
      await fs.writeFile(
        nodePath.join(controlUiRoot, "IDENTITY.md"),
        "- Name: Synthetic assistant\n",
      );
      await withUiServer({
        overrides: {
          controlUiRoot: { kind: "resolved", path: controlUiRoot },
          getRuntimeConfig: () => ({
            agents: {
              ownership: "explicit",
              entries: { ops: {}, research: { workspace } },
              defaults: { systemAgent: { agentId: "research" } },
            },
          }),
        },
        run: async (server) => {
          const identityRuntime = await import("../agents/identity-file-runtime.js");
          const prepareIdentity = vi.spyOn(identityRuntime, "prepareIdentityFile");
          const realpath = vi.spyOn(fsSync, "realpathSync");
          const identityReads = () =>
            realpath.mock.calls.filter(
              ([file]) => nodePath.basename(String(file)) === "IDENTITY.md",
            );
          try {
            for (const method of ["GET", "HEAD"]) {
              const response = await request(server, "/assets/app.js", 200, { method });
              if (method === "HEAD") {
                expect(response.getBody()).toBe("");
              }
            }
            expect(identityReads()).toHaveLength(0);
            expect(prepareIdentity).not.toHaveBeenCalled();

            for (const path of ["/", "/chat"]) {
              const response = await request(server, path, 200);
              expect(response.getBody()).toContain('data-openclaw-bootstrap-config="');
              expect(response.getBody()).toContain(
                "&quot;assistantAgentId&quot;:&quot;research&quot;",
              );
              expect(response.getBody()).toContain(
                "&quot;assistantName&quot;:&quot;Synthetic assistant&quot;",
              );
              expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
            }

            const bootstrap = await sendRequest(server, { path: "/control-ui-config.json" });
            expect(JSON.parse(bootstrap.getBody())).toMatchObject({
              assistantAgentId: "research",
              assistantName: "Synthetic assistant",
            });
            expect(prepareIdentity).toHaveBeenCalledWith(nodePath.join(workspace, "IDENTITY.md"));
            expect(identityReads()).toHaveLength(0);
          } finally {
            prepareIdentity.mockRestore();
            realpath.mockRestore();
          }
        },
      });
    });
  });
});

// Marketplace documents and plugin HTTP routes share only their path prefix.
it("serves marketplace browser reads while preserving plugin HTTP boundaries", async () => {
  await withTempDir("openclaw-marketplace-routing-", async (controlUiRoot) => {
    await fs.writeFile(nodePath.join(controlUiRoot, "index.html"), "<html>spa fallback</html>\n");
    await withUiServer({
      overrides: {
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
        const documentPaths = [
          "/plugins",
          "/plugins/",
          "/plugins/ch_bWF0cml4",
          "/plugins/local_bWVtb3J5",
        ];
        for (const pathname of documentPaths) {
          for (const method of ["GET", "HEAD"]) {
            const { getBody } = await request(server, pathname, 200, {
              method,
              headers: { accept: "text/html" },
            });
            if (method === "GET") {
              expect(getBody()).toContain("spa fallback");
            } else {
              expect(getBody()).toBe("");
            }
          }
        }
        for (const options of [
          ...documentPaths.flatMap((pathname) => [
            { path: pathname, method: "GET", headers: { accept: "application/json" } },
            { path: pathname, method: "GET", headers: { accept: "text/html;q=0" } },
            { path: pathname, method: "POST", headers: { accept: "text/html" } },
          ]),
          { path: "/plugins/unclaimed", method: "GET", headers: { accept: "text/html" } },
          { path: "/plugins/ch_a", method: "GET", headers: { accept: "text/html" } },
          { path: "/plugins/ch_bWF0cml4/extra", method: "GET", headers: { accept: "text/html" } },
        ]) {
          const { getBody } = await request(server, options.path, 404, options);
          expect(getBody()).toBe("Not Found");
        }
        const plugin = await request(server, "/plugins/webhook", 202, {
          headers: { accept: "text/html" },
        });
        expect(plugin.getBody()).toBe("plugin response");
        const pluginManager = await request(server, "/settings/plugins", 200, {
          headers: { accept: "text/html" },
        });
        expect(pluginManager.getBody()).toContain("spa fallback");
      },
    });
  });
});
