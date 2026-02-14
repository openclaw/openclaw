import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function withServer<T>(
  run: (ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"]) => Promise<T>,
) {
  const { server, ws, prevToken } = await startServerWithClient("secret");
  try {
    return await run(ws);
  } finally {
    ws.close();
    await server.close();
    if (prevToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
    }
  }
}

describe("gateway skills.status", () => {
  it("does not expose raw config values to operator.read clients", async () => {
    const prevBundledSkillsDir = process.env.OPENCLAW_BUNDLED_SKILLS_DIR;
    process.env.OPENCLAW_BUNDLED_SKILLS_DIR = path.join(process.cwd(), "skills");
    const secret = "discord-token-secret-abc";
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      session: { mainKey: "main-test" },
      channels: {
        discord: {
          token: secret,
        },
      },
    });

    try {
      await withServer(async (ws) => {
        await connectOk(ws, { token: "secret", scopes: ["operator.read"] });
        const res = await rpcReq<{
          skills?: Array<{
            name?: string;
            configChecks?: Array<{ path?: string; satisfied?: boolean } & Record<string, unknown>>;
          }>;
        }>(ws, "skills.status", {});

        expect(res.ok).toBe(true);
        expect(JSON.stringify(res.payload)).not.toContain(secret);

        const discord = res.payload?.skills?.find((s) => s.name === "discord");
        expect(discord).toBeTruthy();
        const check = discord?.configChecks?.find((c) => c.path === "channels.discord.token");
        expect(check).toBeTruthy();
        expect(check?.satisfied).toBe(true);
        expect(check && "value" in check).toBe(false);
      });
    } finally {
      if (prevBundledSkillsDir === undefined) {
        delete process.env.OPENCLAW_BUNDLED_SKILLS_DIR;
      } else {
        process.env.OPENCLAW_BUNDLED_SKILLS_DIR = prevBundledSkillsDir;
      }
    }
  });
});
