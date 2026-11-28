import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { listAgentIds } from "../agents/agent-scope.js";
import { type AgentsConfig, getRuntimeConfig as getMockedRuntimeConfig } from "../config/config.js";
import { createGatewayConfigOverrides } from "./test-helpers.config-runtime.js";
import {
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  testState,
} from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });
let ws: WebSocket;
installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});
const listAgents = () =>
  rpcReq<{ agents: Array<{ id: string; name?: string }> }>(ws, "agents.list", {});

describe("Gateway fixture config publication", () => {
  async function privateConfigDirectories() {
    if (process.platform === "win32") {
      return [];
    }
    const directories = new Set([
      process.env.OPENCLAW_STATE_DIR!,
      path.dirname(process.env.OPENCLAW_CONFIG_PATH!),
    ]);
    return Promise.all(
      [...directories].map(async (directory) => {
        // These fixture-owned parents must stay private across atomic publication.
        await fs.chmod(directory, 0o700);
        const { dev, ino } = await fs.stat(directory);
        return { directory, dev, ino };
      }),
    );
  }

  async function expectPrivateConfigDirectories(
    directories: Awaited<ReturnType<typeof privateConfigDirectories>>,
  ) {
    for (const { directory, dev, ino } of directories) {
      const current = await fs.stat(directory);
      expect({ dev: current.dev, ino: current.ino, mode: current.mode & 0o777 }).toEqual({
        dev,
        ino,
        mode: 0o700,
      });
    }
  }

  test.each(["reply preparation", "RPC session update"] as const)(
    "%s shares the current fixture with real IO across awaited work",
    async (boundary) => {
      const actual = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
      const { getRuntimeConfig } = await import("../config/io.js");
      const directories = await privateConfigDirectories();
      for (const agentId of ["worker", "reviewer", undefined]) {
        testState.agentsConfig = agentId
          ? { ownership: "explicit", entries: { main: {}, [agentId]: {} } }
          : undefined;
        testState.sessionConfig =
          boundary === "RPC session update" ? { mainKey: agentId ?? "main" } : undefined;
        const admission =
          boundary === "reply preparation"
            ? prepareGatewayReplyRuntimeForTest({ force: true })
            : listAgents();
        // Real maintenance/finalizer callbacks can read config while admission
        // yields for imports or model preparation, before the RPC is sent.
        const duringAdmission = actual.getRuntimeConfig();
        await admission;
        const expectedAgents = agentId ? ["main", agentId] : ["main"];
        expect(listAgentIds(duringAdmission)).toEqual(expectedAgents);
        if (boundary === "RPC session update") {
          expect(duringAdmission.session?.mainKey).toBe(agentId ?? "main");
        }
        expect(listAgentIds(actual.getRuntimeConfig())).toEqual(expectedAgents);
        expect(getRuntimeConfig()).toEqual(actual.getRuntimeConfig());
        const response = await listAgents();
        expect(response.ok, JSON.stringify(response)).toBe(true);
        expect(response.payload?.agents.map((agent) => agent.id)).toEqual(expectedAgents);
        await expectPrivateConfigDirectories(directories);
      }
    },
  );

  test("publishes agent-only edits and removals without overwriting authored config", async () => {
    const actual = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
    const { writeConfigFile } = createGatewayConfigOverrides(actual);
    const configPath = process.env.OPENCLAW_CONFIG_PATH!;
    const directories = await privateConfigDirectories();
    const store = path.join(path.dirname(configPath), "agents", "{agentId}", "sessions.json");
    const authoredConfig = {
      agents: {
        ownership: "explicit",
        entries: { main: { name: "Authored main" } },
        defaults: { userTimezone: "UTC", timeoutSeconds: 90 },
      } satisfies AgentsConfig,
      session: { store },
    };
    await writeConfigFile(authoredConfig);
    await expectPrivateConfigDirectories(directories);
    const workspace = path.join(path.dirname(configPath), "fixture-workspace");
    const secondary = { name: "Fixture secondary", workspace };
    // Publication must not inject main, even after deletion leaves a sole fixture agent.
    const entries: NonNullable<AgentsConfig["entries"]> = { primary: { workspace }, secondary };
    testState.agentsConfig = { ownership: "explicit", entries };
    testState.agentConfig = { timeoutSeconds: 45 };

    const expectPublished = async (
      expectedEntries: NonNullable<AgentsConfig["entries"]>,
      timeoutSeconds: number,
    ) => {
      const request = listAgents();
      try {
        const realConfig = actual.getRuntimeConfig();
        expect(realConfig.agents?.entries).toEqual(expectedEntries);
        expect(realConfig.agents?.defaults).toMatchObject({ userTimezone: "UTC", timeoutSeconds });
        expect(realConfig.session?.store).toBe(store);
        expect(getMockedRuntimeConfig()).toEqual(realConfig);
        const response = await request;
        expect(response.ok, JSON.stringify(response)).toBe(true);
        expect(response.payload?.agents.map(({ id, name }) => ({ id, name }))).toEqual(
          Object.entries(expectedEntries).map(([id, { name }]) => ({ id, name })),
        );
        expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(authoredConfig);
      } finally {
        await request;
      }
    };

    await expectPublished(
      { primary: { workspace }, secondary: { name: "Fixture secondary", workspace } },
      45,
    );
    // Entries can alias the published snapshot; the copied default must also refresh.
    secondary.name = "Updated fixture";
    testState.agentConfig.timeoutSeconds = 60;
    await expectPublished(
      { primary: { workspace }, secondary: { name: "Updated fixture", workspace } },
      60,
    );
    delete entries.secondary;
    delete testState.agentConfig.timeoutSeconds;
    await expectPublished({ primary: { workspace } }, 90);
    testState.agentsConfig = undefined;
    testState.agentConfig = undefined;
    await expectPublished({ main: { name: "Authored main" } }, 90);

    authoredConfig.agents.entries.main.name = "Updated file intent";
    await fs.writeFile(configPath, JSON.stringify(authoredConfig));
    testState.agentConfig = { timeoutSeconds: 30 };
    await expectPublished({ main: { name: "Updated file intent" } }, 30);
  });
});
