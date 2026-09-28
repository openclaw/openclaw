import fs from "node:fs/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { setTestEnvValue, withEnvAsync } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import {
  loadGatewayConfig,
  openAuthenticatedGatewayWs,
  waitForGatewayWsClose,
} from "./shared-auth.test-helpers.js";
import {
  installGatewayTestHooks,
  rpcReq,
  startTestGatewayServer,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const SECRET_REF_TOKEN_ID = "OPENCLAW_SHARED_TOKEN_HOT_RELOAD_SECRET_REF";
const OLD_TOKEN = "shared-token-old";
const NEW_TOKEN = "shared-token-new";

it.each(["config.set", "secrets.reload"])(
  "%s invalidates shared-token sessions with automatic reload disabled",
  async (method) => {
    const originalAuth = testState.gatewayAuth;
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
    }
    await withEnvAsync({ [SECRET_REF_TOKEN_ID]: OLD_TOKEN }, async () => {
      testState.gatewayAuth = undefined;
      let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
      let ws: Awaited<ReturnType<typeof openAuthenticatedGatewayWs>> | undefined;
      try {
        await fs.writeFile(
          configPath,
          JSON.stringify({
            gateway: {
              auth: {
                mode: "token",
                token:
                  method === "config.set"
                    ? OLD_TOKEN
                    : { source: "env", provider: "default", id: SECRET_REF_TOKEN_ID },
              },
              reload: { mode: "off" },
            },
          }),
        );
        const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
        server = await startTestGatewayServer(portClaim, { controlUiEnabled: true });
        ws = await openAuthenticatedGatewayWs(portClaim.port, OLD_TOKEN);
        let params = {};
        if (method === "config.set") {
          const current = await loadGatewayConfig(ws);
          const gateway = asOptionalRecord(current.config.gateway);
          params = {
            baseHash: current.hash,
            raw: JSON.stringify({
              ...current.config,
              gateway: {
                ...gateway,
                auth: { ...asOptionalRecord(gateway?.auth), mode: "token", token: NEW_TOKEN },
              },
            }),
          };
        } else {
          setTestEnvValue(SECRET_REF_TOKEN_ID, NEW_TOKEN);
        }
        const closed = waitForGatewayWsClose(ws, method === "config.set" ? 30_000 : 10_000);
        const result = await rpcReq(ws, method, params);
        await expect(closed).resolves.toEqual({ code: 4001, reason: "gateway auth changed" });
        expect(result.ok).toBe(true);
        if (method === "secrets.reload") {
          const fresh = await openAuthenticatedGatewayWs(portClaim.port, NEW_TOKEN);
          fresh.close();
        }
      } finally {
        ws?.close();
        testState.gatewayAuth = originalAuth;
        await server?.close();
      }
    });
  },
);
