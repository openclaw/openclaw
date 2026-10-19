import fs from "node:fs";
import { expect, it } from "vitest";
import type { SessionsCreateResult } from "../../packages/gateway-protocol/src/schema/sessions.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";

const transcriptMessage = (eventId: string, parentId: string | null, role = "assistant") => ({
  eventId,
  parentId,
  message: { role, content: eventId },
});
type SessionIdentity = { key: string; sessionId: string; incognito: boolean };
const eventNames = ["sessions.changed", "session.message"];

it("serves authorized incognito descriptions, events, and active-branch history", async () => {
  const state = await createOpenClawTestState({
    label: "incognito-reconcile-gateway",
    env: {
      ...KERNEL_TEST_ENV,
      VITEST: process.env.VITEST,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  const events: Array<{ event?: string; payload?: unknown }> = [];
  await runQaGatewayFixture(
    async () => {
      const cfg = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            model: { primary: "openai/gpt-5.5" },
            heartbeat: { every: "0m" },
          },
        },
        plugins: { slots: { memory: "none" } },
        tools: { profile: "minimal" },
        gateway: { auth: { mode: "token", token: "incognito-reconcile-test" } },
      } satisfies OpenClawConfig;
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token: "incognito-reconcile-test",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        onEvent: (event) => {
          if (event.event && eventNames.includes(event.event)) {
            events.push(event);
          }
        },
      });
      await gateway.server.startupSettled;
      const { client } = gateway;
      await client.request("sessions.subscribe", {});
      const created = await client.request<SessionsCreateResult & { sessionId: string }>(
        "sessions.create",
        {
          agentId: "main",
          incognito: true,
        },
      );
      expect(created).toMatchObject({ entry: { incognito: true }, runStarted: false });
      const { key, sessionId } = created;
      const identity = { key, sessionId, incognito: true };
      const described = await client.request<{ session: unknown }>("sessions.describe", {
        agentId: "main",
        key,
      });
      expect.soft(described.session).toMatchObject(identity);
      // Write through the memory owner, then query authenticated history.
      const append = (messages: Parameters<typeof persistSessionTranscriptTurn>[1]["messages"]) =>
        persistSessionTranscriptTurn(
          { agentId: "main", sessionKey: key, sessionId },
          { expectedSessionId: sessionId, messages },
        );
      await append([
        transcriptMessage("root", null, "user"),
        transcriptMessage("abandoned", "root"),
        transcriptMessage("active", "root"),
      ]);
      const history = await client.request<{
        sessionId: string;
        sessionInfo?: SessionIdentity & { modelProvider: string; model: string };
        messages: Array<{ role: string; content: unknown }>;
      }>("chat.history", { agentId: "main", sessionKey: key, limit: 10 });
      await append([transcriptMessage("published", "active")]);
      const payload = expect.objectContaining({
        sessionKey: key,
        session: expect.objectContaining({ sessionId, incognito: true }),
      });
      const expectedEvents = eventNames.map((event) => expect.objectContaining({ event, payload }));
      await expect.poll(() => events).toEqual(expect.arrayContaining(expectedEvents));
      const roster = await client.request<{ sessions: Array<{ key: string }> }>(
        "sessions.list",
        {},
      );
      expect(roster.sessions.map((session) => session.key)).not.toContain(key);
      expect(history.sessionId).toBe(sessionId);
      expect(history.sessionInfo).toMatchObject({
        ...identity,
        modelProvider: "openai",
        model: "gpt-5.5",
      });
      expect(history.messages.map(({ role, content }) => ({ role, content }))).toEqual([
        { role: "user", content: "root" },
        { role: "assistant", content: "active" },
      ]);
      const memoryPath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
      expect(fs.existsSync(memoryPath)).toBe(false);
      const durable = withOpenClawAgentDatabaseReadOnly(
        ({ db }) => ({
          events: db
            .prepare("SELECT count(*) AS count FROM transcript_events WHERE session_id = ?")
            .get(sessionId),
          nodes: db
            .prepare("SELECT count(*) AS count FROM session_nodes WHERE session_key = ?")
            .get(key),
        }),
        { agentId: "main" },
      );
      if (durable.found) {
        expect(durable.value).toEqual({ events: { count: 0 }, nodes: { count: 0 } });
      } else {
        expect(["database-missing", "schema-missing"]).toContain(durable.reason);
        if (durable.reason === "schema-missing") {
          // Admission may reserve an empty file without creating durable session storage.
          using empty = openNodeSqliteDatabase(
            resolveOpenClawAgentSqlitePath({ agentId: "main" }),
            { readOnly: true },
          );
          expect(
            empty
              .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('transcript_events', 'session_nodes')",
              )
              .all(),
          ).toEqual([]);
        }
      }
    },
    () => gateway && disconnectGatewayClient(gateway.client),
    () => gateway?.server.close({ reason: "incognito reconciliation test cleanup" }),
    () => state.cleanup(),
  );
});
