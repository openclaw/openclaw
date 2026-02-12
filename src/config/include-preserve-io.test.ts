import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { createConfigIO } from "./io.js";

async function withTempConfig(
  files: Record<string, unknown>,
  run: (configDir: string, configPath: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-include-io-"));
  const configPath = path.join(dir, "openclaw.json");

  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(content, null, 2));
  }

  try {
    await run(dir, configPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("$include preservation via createConfigIO", () => {
  it("preserves $include directive after write roundtrip", async () => {
    const baseContent = {
      agents: {
        list: [{ id: "base-agent", workspace: "~/agents/base" }],
      },
    };

    const mainConfig = {
      $include: "./base.json5",
      gateway: { port: 18789, bind: "loopback" },
    };

    await withTempConfig(
      {
        "openclaw.json": mainConfig,
        "base.json5": baseContent,
      },
      async (_dir, configPath) => {
        const io = createConfigIO({ configPath });
        const snapshot = await io.readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);

        // Modify a local key and write back
        const modified = {
          ...snapshot.config,
          gateway: { ...snapshot.config.gateway, port: 19000 },
        };

        await io.writeConfigFile(modified);

        const written = await fs.readFile(configPath, "utf-8");
        const parsed = JSON.parse(written);

        expect(parsed["$include"]).toBe("./base.json5");
        expect(parsed.gateway.port).toBe(19000);
        // agents from include should NOT be inlined
        expect(parsed.agents).toBeUndefined();
      },
    );
  });

  it("preserves $include when config is written back unchanged", async () => {
    const baseContent = {
      agents: {
        list: [{ id: "base-agent" }],
      },
    };

    const mainConfig = {
      $include: "./base.json5",
      gateway: { port: 18789 },
    };

    await withTempConfig(
      {
        "openclaw.json": mainConfig,
        "base.json5": baseContent,
      },
      async (_dir, configPath) => {
        const io = createConfigIO({ configPath });
        const snapshot = await io.readConfigFileSnapshot();

        await io.writeConfigFile(snapshot.config);

        const written = await fs.readFile(configPath, "utf-8");
        const parsed = JSON.parse(written);

        expect(parsed["$include"]).toBe("./base.json5");
        expect(parsed.agents).toBeUndefined();
      },
    );
  });

  it("writes config normally when no $include is present", async () => {
    await withTempConfig(
      {
        "openclaw.json": { gateway: { port: 18789 } },
      },
      async (_dir, configPath) => {
        const io = createConfigIO({ configPath });
        const snapshot = await io.readConfigFileSnapshot();

        const modified = {
          ...snapshot.config,
          gateway: { ...snapshot.config.gateway, port: 19000 },
        };

        await io.writeConfigFile(modified);

        const written = await fs.readFile(configPath, "utf-8");
        const parsed = JSON.parse(written);
        expect(parsed.gateway.port).toBe(19000);
      },
    );
  });

  it("preserves array $include", async () => {
    const agentsContent = {
      agents: { list: [{ id: "agent1" }] },
    };
    const channelsContent = {
      channels: { telegram: { dmPolicy: "pairing" } },
    };

    const mainConfig = {
      $include: ["./agents.json5", "./channels.json5"],
      gateway: { port: 18789 },
    };

    await withTempConfig(
      {
        "openclaw.json": mainConfig,
        "agents.json5": agentsContent,
        "channels.json5": channelsContent,
      },
      async (_dir, configPath) => {
        const io = createConfigIO({ configPath });
        const snapshot = await io.readConfigFileSnapshot();

        await io.writeConfigFile(snapshot.config);

        const written = await fs.readFile(configPath, "utf-8");
        const parsed = JSON.parse(written);

        expect(parsed["$include"]).toEqual(["./agents.json5", "./channels.json5"]);
        expect(parsed.agents).toBeUndefined();
        expect(parsed.channels).toBeUndefined();
      },
    );
  });
});
