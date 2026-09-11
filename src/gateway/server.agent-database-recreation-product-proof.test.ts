import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentsDeleteResult } from "../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  closeOpenClawAgentDatabasesForTest,
  inspectOpenClawAgentDatabaseOwner,
  listOpenClawRegisteredAgentDatabases,
} from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { GatewayClient } from "./client.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import {
  getGatewayTestPort,
  installGatewayTestHooks,
  startTestGatewayServer,
} from "./test-helpers.js";

const AGENT_ID = "recreated-agent";
const EXTERNAL_STATE_AGENT_ID = "external-state-agent";
const SESSION_KEY = `agent:${AGENT_ID}:product-proof`;

installGatewayTestHooks();

describe("agent database recreation product proof", () => {
  it(
    "recreates and registers a deleted agent database through one real Gateway process",
    { timeout: 180_000 },
    async () => {
      const port = await getGatewayTestPort();
      const token = "agent-database-recreation-product-proof-token";
      const url = `ws://127.0.0.1:${port}`;
      const server = await startTestGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      let client: GatewayClient | undefined;
      try {
        client = await connectGatewayClient({
          url,
          token,
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });

        const workspace = path.join(
          process.env.OPENCLAW_STATE_DIR ?? process.cwd(),
          "workspace-recreated-agent",
        );
        const created = await client.request<{ agentId: string; ok: true }>("agents.create", {
          name: "Recreated Agent",
          workspace,
        });
        expect(created).toMatchObject({ agentId: AGENT_ID, ok: true });
        await expect(
          client.request("sessions.create", { agentId: AGENT_ID, key: SESSION_KEY }),
        ).resolves.toMatchObject({ key: SESSION_KEY });
        await expect(client.request("sessions.list", { agentId: AGENT_ID })).resolves.toMatchObject(
          { sessions: [expect.objectContaining({ key: SESSION_KEY })] },
        );

        const databasePath = resolveOpenClawAgentSqlitePath({
          agentId: AGENT_ID,
          env: process.env,
        });
        const originalIdentity = await fs.stat(databasePath, { bigint: true });

        await expect(
          client.request("agents.delete", { agentId: AGENT_ID, deleteFiles: true }),
        ).resolves.toMatchObject({ agentId: AGENT_ID, ok: true });
        await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });

        const recreated = await client.request<{ agentId: string; ok: true }>("agents.create", {
          name: "Recreated Agent",
          workspace,
        });
        expect(recreated).toMatchObject({ agentId: AGENT_ID, ok: true });
        await expect(
          client.request("sessions.create", { agentId: AGENT_ID, key: SESSION_KEY }),
        ).resolves.toMatchObject({ key: SESSION_KEY });
        await expect(client.request("sessions.list", { agentId: AGENT_ID })).resolves.toMatchObject(
          { sessions: [expect.objectContaining({ key: SESSION_KEY })] },
        );
        await expect(client.request("health", { probe: true })).resolves.toBeDefined();

        const recreatedIdentity = await fs.stat(databasePath, { bigint: true });
        expect({
          birthtimeNs: recreatedIdentity.birthtimeNs,
          dev: recreatedIdentity.dev,
          ino: recreatedIdentity.ino,
        }).not.toEqual({
          birthtimeNs: originalIdentity.birthtimeNs,
          dev: originalIdentity.dev,
          ino: originalIdentity.ino,
        });
        expect(inspectOpenClawAgentDatabaseOwner(databasePath)).toEqual({
          agentId: AGENT_ID,
          status: "owned",
        });
        expect(listOpenClawRegisteredAgentDatabases({ env: process.env })).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ agentId: AGENT_ID, path: databasePath }),
          ]),
        );
      } finally {
        if (client) {
          await disconnectGatewayClient(client);
        }
        await server.close({ reason: "agent database recreation product proof complete" });
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
      }
    },
  );
});

describe("agent deletion product proof with a state dir outside home and the temp dir", () => {
  it(
    "moves the deleted agent's files to Trash through one real Gateway process",
    { timeout: 180_000 },
    async () => {
      // Volume-backed deployments keep OPENCLAW_STATE_DIR outside HOME and os.tmpdir()
      // (for example /data on Fly), which are fs-safe's default Trash roots.
      const realTmp = await fs.realpath(os.tmpdir());
      const tmpOverride = await fs.mkdtemp(path.join(realTmp, "openclaw-tmp-override-"));
      const stateDir = await fs.mkdtemp(path.join(realTmp, "openclaw-external-state-"));
      const port = await getGatewayTestPort();
      const token = "agent-delete-external-state-dir-token";
      const url = `ws://127.0.0.1:${port}`;
      try {
        await withEnvAsync(
          {
            OPENCLAW_STATE_DIR: stateDir,
            TMPDIR: tmpOverride,
            TMP: tmpOverride,
            TEMP: tmpOverride,
          },
          async () => {
            expect(isPathInside(await fs.realpath(os.homedir()), stateDir)).toBe(false);
            expect(isPathInside(await fs.realpath(os.tmpdir()), stateDir)).toBe(false);
            const server = await startTestGatewayServer(port, {
              bind: "loopback",
              auth: { mode: "token", token },
              controlUiEnabled: false,
            });
            let client: GatewayClient | undefined;
            try {
              client = await connectGatewayClient({
                url,
                token,
                role: "operator",
                scopes: ["operator.admin", "operator.read", "operator.write"],
              });
              const workspace = path.join(stateDir, "workspace-external-state-agent");
              await expect(
                client.request("agents.create", { name: "External State Agent", workspace }),
              ).resolves.toMatchObject({ agentId: EXTERNAL_STATE_AGENT_ID, ok: true });
              await fs.writeFile(path.join(workspace, "NOTES.md"), "keep me in Trash\n");

              const result = await client.request<AgentsDeleteResult>("agents.delete", {
                agentId: EXTERNAL_STATE_AGENT_ID,
                deleteFiles: true,
              });

              // Database files are removed by the database-owned deletion first; the
              // workspace and session directories are what reach Trash here.
              expect(result).toMatchObject({
                agentId: EXTERNAL_STATE_AGENT_ID,
                ok: true,
                failed: [],
              });
              expect(result.removed).toEqual(
                expect.arrayContaining([{ path: workspace, method: "trash" }]),
              );
              await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
            } finally {
              if (client) {
                await disconnectGatewayClient(client);
              }
              await server.close({ reason: "agent delete external state dir test complete" });
            }
          },
        );
      } finally {
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
        await fs.rm(tmpOverride, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
    },
  );
});
