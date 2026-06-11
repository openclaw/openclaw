/** Tests persistent node-host config normalization. */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { ensureNodeHostConfig } from "./config.js";

describe("ensureNodeHostConfig", () => {
  it("keeps legacy node ids generated until the user sets --node-id again", async () => {
    await withStateDirEnv("openclaw-node-host-config-user-", async ({ stateDir }) => {
      await fs.writeFile(
        path.join(stateDir, "node.json"),
        JSON.stringify({ version: 1, nodeId: "my-mac-node" }),
        "utf8",
      );

      const config = await ensureNodeHostConfig();

      expect(config.nodeId).toBe("my-mac-node");
      expect(config.nodeIdSource).toBe("generated");
    });
  });

  it("keeps legacy uuid node ids generated", async () => {
    await withStateDirEnv("openclaw-node-host-config-generated-", async ({ stateDir }) => {
      await fs.writeFile(
        path.join(stateDir, "node.json"),
        JSON.stringify({ version: 1, nodeId: "11111111-1111-4111-8111-111111111111" }),
        "utf8",
      );

      const config = await ensureNodeHostConfig();

      expect(config.nodeId).toBe("11111111-1111-4111-8111-111111111111");
      expect(config.nodeIdSource).toBe("generated");
    });
  });
});
