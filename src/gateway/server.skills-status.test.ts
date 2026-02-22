import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { connectOk, installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { withServer } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway skills.status", () => {
  it("does not expose raw config values to operator.read clients", async () => {
    await withEnvAsync(
      { OPENCLAW_BUNDLED_SKILLS_DIR: path.join(process.cwd(), "skills") },
      async () => {
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

        await withServer(async (ws) => {
          await connectOk(ws, { token: "secret", scopes: ["operator.read"] });
          const res = await rpcReq<{
            skills?: Array<{
              name?: string;
              configChecks?: Array<
                { path?: string; satisfied?: boolean } & Record<string, unknown>
              >;
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
      },
    );
  });
});
