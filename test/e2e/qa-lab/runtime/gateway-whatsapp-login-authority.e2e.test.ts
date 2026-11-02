import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ADMIN_SCOPE, WRITE_SCOPE } from "../../../../src/gateway/operator-scopes.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";

let instance: OpenClawTestInstance | undefined;

afterEach(async () => {
  await instance?.cleanup();
  instance = undefined;
});

it(
  "hides credential relinking from non-owners and preserves the owner wait flow",
  { timeout: 120_000 },
  async () => {
    instance = await createOpenClawTestInstance({
      name: "qa-whatsapp-login-authority",
      env: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "dist", "extensions"),
      },
      config: {
        plugins: {
          enabled: true,
          allow: ["whatsapp"],
          entries: { whatsapp: { enabled: true } },
        },
        agents: {
          entries: { main: { tools: { allow: ["whatsapp_login"] } } },
        },
        gateway: { tools: { allow: ["whatsapp_login"] } },
      },
    });

    const credsPath = path.join(instance.stateDir, "credentials/whatsapp/default/creds.json");
    const sentinel = `${JSON.stringify({ registered: true, proof: "preserve" })}\n`;
    await fs.mkdir(path.dirname(credsPath), { recursive: true });
    await fs.writeFile(credsPath, sentinel, "utf8");
    await instance.startGateway();

    const started = instance;
    const connect = (owner: boolean) =>
      connectGatewayClient({
        url: started.url,
        token: started.gatewayToken,
        scopes: owner ? [ADMIN_SCOPE, WRITE_SCOPE] : [WRITE_SCOPE],
        clientDisplayName: `whatsapp-login-${owner ? "owner" : "non-owner"}`,
        deviceFamily: `whatsapp-login-${owner ? "owner" : "non-owner"}`,
        timeoutMs: 30_000,
      });
    const nonOwner = await connect(false);
    const owner = await connect(true);

    try {
      const denied = await nonOwner.request("tools.invoke", {
        name: "whatsapp_login",
        args: { action: "start", force: true, timeoutMs: 1 },
        sessionKey: "main",
      });
      expect(denied).toEqual({
        ok: false,
        toolName: "whatsapp_login",
        error: { code: "not_found", message: "Tool not available: whatsapp_login" },
      });
      await expect(fs.readFile(credsPath, "utf8")).resolves.toBe(sentinel);

      const allowed = await owner.request("tools.invoke", {
        name: "whatsapp_login",
        args: { action: "wait", timeoutMs: 1 },
        sessionKey: "main",
      });
      expect(allowed).toMatchObject({
        ok: true,
        toolName: "whatsapp_login",
        source: "plugin",
        output: {
          content: [{ type: "text", text: "No active WhatsApp login in progress." }],
          details: { connected: false },
        },
      });
    } finally {
      await disconnectGatewayClient(owner);
      await disconnectGatewayClient(nonOwner);
    }
  },
);
