import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConfigIO } from "./io.js";
import { withTempHome } from "./test-helpers.js";

describe("config io write", () => {
  it("persists caller changes onto resolved config without leaking runtime defaults", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ gateway: { port: 18789 } }, null, 2),
        "utf-8",
      );

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
      });

      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      const next = structuredClone(snapshot.config);
      next.gateway = {
        ...next.gateway,
        auth: { mode: "token" },
      };

      await io.writeConfigFile(next);

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<
        string,
        unknown
      >;
      expect(persisted.gateway).toEqual({
        port: 18789,
        auth: { mode: "token" },
      });
      expect(persisted).not.toHaveProperty("agents.defaults");
      expect(persisted).not.toHaveProperty("messages.ackReaction");
      expect(persisted).not.toHaveProperty("sessions.persistence");
    });
  });
});
