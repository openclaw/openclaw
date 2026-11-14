import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { createMcpProbeFixture } from "../agents/agent-bundle-mcp-probe.test-support.js";
import { probeMcpServers } from "../cli/mcp-cli-probe.js";
import { migrateLegacyConfig } from "../commands/doctor/shared/legacy-config-migrate.js";
import { startNodeHostMcpManager } from "../node-host/mcp.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createConfigIO } from "./io.js";
import type { OpenClawConfig } from "./types.js";
import type { McpServerConfig } from "./types.mcp.js";

const fixtureDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    fixtureDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

it.each(["mcp", "nodeHost"] as const)(
  "preserves %s transport intent through Doctor until explicit repair and rejects requester process I/O",
  async (owner) => {
    await withOpenClawTestState({ prefix: "mcp-repair-effect-" }, async (state) => {
      const fixture = await createMcpProbeFixture(fixtureDirs);
      const serverPath = path.join(fixture.params.workspaceDir, "server.mjs");
      const starts = path.join(fixture.params.workspaceDir, "starts.log");
      await fs.writeFile(
        serverPath,
        `import { appendFileSync as recordStart } from "node:fs"; recordStart(${JSON.stringify(starts)}, process.argv[2] + "\\n");\n` +
          (await fs.readFile(serverPath, "utf8")),
      );
      const launch = expectDefined(fixture.config().mcp?.servers?.healthy, "healthy MCP fixture");
      const io = createConfigIO({
        configPath: state.configPath,
        observe: false,
        pluginValidation: "core-only",
      });
      const wrap = (server: McpServerConfig, legacy = false): OpenClawConfig => {
        const mcp = {
          servers: {
            docs: legacy ? { ...server, disabled: true, connectTimeout: 3, timeout: 12 } : server,
            ...(legacy ? { disabled: { command: "never-run", disabled: true } } : {}),
          },
        };
        return {
          plugins: { enabled: false },
          ...(owner === "mcp" ? { mcp } : { nodeHost: { mcp } }),
        };
      };
      async function doctor(server: McpServerConfig) {
        const raw = wrap(server, true);
        await state.writeConfig(raw);
        expect((await io.readConfigFileSnapshot()).valid).toBe(false);
        const repaired = migrateLegacyConfig(raw, {
          sourceConfigBeforeMigrations: raw,
          pluginContracts: false,
        });
        await io.writeConfigFile(
          expectDefined(repaired.sourceConfig ?? repaired.config, "Doctor migration result"),
        );
        const snapshot = await io.readConfigFileSnapshot();
        expect(snapshot.warnings).toContainEqual({
          path: `${owner === "mcp" ? "mcp" : "nodeHost.mcp"}.servers.docs`,
          message: expect.stringMatching(/command.*url.*Doctor/),
        });
        return snapshot.sourceConfig;
      }
      async function connect() {
        const config = io.loadConfig();
        if (owner === "mcp") {
          return (await probeMcpServers("mixed-repair-proof", config, config.mcp?.servers ?? {}))
            .tools;
        }
        const manager = await startNodeHostMcpManager(config.nodeHost?.mcp?.servers);
        try {
          return manager.descriptors.map((tool) => tool.name);
        } finally {
          await manager.close();
        }
      }
      const stdio = {
        ...launch,
        args: [serverPath, "shared"],
        env: { MODE: "test" },
        cwd: fixture.params.workspaceDir,
        requestTimeoutMs: 5000,
        toolFilter: { include: ["probe"] },
      };
      const shared = {
        ...stdio,
        type: "http",
        url: "https://example.invalid/mcp",
        headers: { "X-Test": "test" },
        auth: "oauth" as const,
        oauth: { identity: "shared" as const },
        sslVerify: false,
        clientCert: "/example-cert",
        clientKey: "/example-key",
      };
      const persisted = await doctor(shared);
      expect(
        owner === "mcp"
          ? persisted.mcp?.servers?.disabled
          : persisted.nodeHost?.mcp?.servers?.disabled,
      ).toEqual({ command: "never-run", enabled: false });
      const { type: _type, ...canonical } = shared;
      expect(
        owner === "mcp" ? persisted.mcp?.servers?.docs : persisted.nodeHost?.mcp?.servers?.docs,
      ).toEqual({
        ...canonical,
        transport: "streamable-http",
        enabled: false,
        connectionTimeoutMs: 3000,
      });
      expect(
        migrateLegacyConfig(persisted, {
          sourceConfigBeforeMigrations: persisted,
          pluginContracts: false,
        }),
      ).toMatchObject({ config: null, changes: [] });
      expect(JSON.parse(await fs.readFile(`${state.configPath}.bak`, "utf8"))).toMatchObject(
        wrap(shared, true),
      );
      await expect(fs.readFile(starts)).rejects.toMatchObject({ code: "ENOENT" });
      await io.writeConfigFile(wrap(stdio));
      expect(await connect()).toEqual([expect.stringContaining("probe")]);
      expect(await fs.readFile(starts, "utf8")).toBe("shared\n");
      for (const auth of ["oauth", undefined] as const) {
        await expect(
          doctor({
            ...shared,
            args: [serverPath, "requester"],
            auth,
            oauth: { identity: "per-requester" },
          }),
        ).rejects.toThrow(/per-requester/);
        expect(await fs.readFile(starts, "utf8")).toBe("shared\n");
      }
    });
  },
);
