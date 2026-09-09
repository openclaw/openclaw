import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";

describe("plugin Gateway returned values", () => {
  it("loads a cast-free TypeScript plugin and returns its payload through Gateway RPC", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-gateway-return-"));
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const pluginDir = path.join(root, "plugin");
    await Promise.all([
      fs.mkdir(stateDir, { recursive: true }),
      fs.mkdir(workspaceDir, { recursive: true }),
      fs.mkdir(pluginDir, { recursive: true }),
    ]);
    await fs.writeFile(path.join(pluginDir, "package.json"), '{"type":"module"}\n');
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({ id: "ts-gateway-return", configSchema: { type: "object" } }),
    );
    await fs.writeFile(
      path.join(pluginDir, "index.ts"),
      `export default {
  id: "ts-gateway-return",
  register(api: import("../../../../src/plugins/plugin-api.types.js").OpenClawPluginApi) {
    api.registerGatewayMethod("ts-gateway-return.echo", async () => ({ ok: true, source: "typescript" }));
  },
};
`,
    );
    const token = "plugin-gateway-return-test-token";
    const config = {
      agents: {
        defaults: { workspace: workspaceDir, skipBootstrap: true },
        entries: { main: { default: true } },
      },
      gateway: { auth: { mode: "token", token } },
      plugins: {
        enabled: true,
        allow: ["ts-gateway-return"],
        load: { paths: [pluginDir] },
        entries: { "ts-gateway-return": { enabled: true } },
        slots: { memory: "none" },
      },
    } satisfies OpenClawConfig;
    const previous = { HOME: process.env.HOME, OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR };
    process.env.HOME = root;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      gateway = await startGatewayWithClient({
        cfg: config,
        configPath: path.join(stateDir, "openclaw.json"),
        token,
        clientDisplayName: "plugin-gateway-return-proof",
      });
      await expect(gateway.client.request("ts-gateway-return.echo", {})).resolves.toEqual({
        ok: true,
        source: "typescript",
      });
    } finally {
      if (gateway) await disconnectGatewayClient(gateway.client);
      if (previous.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = previous.HOME;
      if (previous.OPENCLAW_STATE_DIR === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previous.OPENCLAW_STATE_DIR;
    }
  }, 120_000);
});
