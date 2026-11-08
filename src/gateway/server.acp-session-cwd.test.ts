import fs from "node:fs/promises";
import path from "node:path";
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { afterEach, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createNewSessionRequest } from "../acp/translator.bridge-test-helpers.js";
import {
  createAcpConnection,
  createAcpGateway,
  createAcpGatewayAgent,
} from "../acp/translator.test-helpers.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { GatewayClient } from "./client.js";
import { setupSessionCreateTestHarness } from "./server.sessions.create.test-support.js";
import { rpcReq, testState } from "./test-helpers.js";

const { createSessionStoreDir, openClient } = setupSessionCreateTestHarness();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

test.each(["fresh", "fresh-reset", "adopt"])(
  "ACP session/new keeps the Gateway-owned directory (%s)",
  async (mode) => {
    const adoptExisting = mode === "adopt";
    const workspace = tempDirs.make("openclaw-acp-cwd-");
    const requestedCwd = path.join(workspace, "requested");
    const existingCwd = path.join(workspace, "existing");
    await fs.mkdir(requestedCwd);
    await fs.mkdir(existingCwd);
    testState.agentConfig = { workspace };
    const { storePath } = await createSessionStoreDir();
    const { ws } = await openClient({ scopes: ["operator.admin"] });
    const existingKey = "agent:main:acp-bridge:existing-project";
    try {
      if (adoptExisting) {
        const created = await rpcReq(ws, "sessions.create", { key: existingKey, cwd: existingCwd });
        expect(created.ok, JSON.stringify(created.error)).toBe(true);
      }
      const sessionStore = createInMemorySessionStore();
      const request = async (method: string, params: unknown) => {
        const result = await rpcReq(ws, method, params);
        if (!result.ok) {
          throw new Error(result.error?.message ?? "Gateway request failed");
        }
        return result.payload;
      };
      const agent = createAcpGatewayAgent(
        createAcpConnection(),
        createAcpGateway(request as GatewayClient["request"]),
        { sessionStore, resetSession: mode === "fresh-reset" },
      );
      const created = await agent.newSession({
        ...createNewSessionRequest(requestedCwd),
        _meta: adoptExisting ? { sessionKey: existingKey } : {},
      });
      const session = sessionStore.getSession(created.sessionId);
      if (!session) {
        throw new Error("ACP session was not created");
      }
      const sessionKey = session.sessionKey;
      const persisted = loadSessionEntry({ agentId: "main", sessionKey, storePath });
      expect(persisted?.spawnedCwd).toBe(adoptExisting ? existingCwd : requestedCwd);
      const listed = await agent.listSessions({ cwd: adoptExisting ? existingCwd : requestedCwd });
      expect(listed.sessions).toContainEqual(
        expect.objectContaining({ cwd: adoptExisting ? existingCwd : requestedCwd }),
      );
    } finally {
      ws.close();
      testState.agentConfig = undefined;
    }
  },
);
