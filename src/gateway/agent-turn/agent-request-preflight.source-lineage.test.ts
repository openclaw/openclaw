import path from "node:path";
import { expect, it, vi } from "vitest";
import { upsertAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createChatRunState } from "../server-chat-state.js";
import { prepareAgentRequestPreflight } from "./agent-request-preflight.js";
import { createAgentTurnIo } from "./io.js";
import type { AgentTurnContext } from "./types.js";

it.each([
  { kind: "child", location: "configured", expectedRole: "subagent" },
  { kind: "child", location: "alternate", expectedRole: "subagent" },
  { kind: "peer", location: "alternate", expectedRole: undefined },
  { kind: "acp", location: "alternate", expectedRole: "subagent" },
])(
  "admits $kind lineage from the $location canonical store",
  async ({ kind, location, expectedRole }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {}, worker: {} } },
        session: { store: path.join(state.root, "configured", "{agentId}", "sessions.json") },
      };
      await state.writeConfig(cfg);
      const parentKey = "agent:main:dashboard:requester";
      const sourceKey = `agent:worker:${kind === "acp" ? "acp" : "dashboard"}:source`;
      const sourceStorePath = resolveSessionStorePathCore(
        location === "configured" ? cfg.session?.store : undefined,
        { agentId: "worker", env: state.env },
      );
      await replaceSessionEntry(
        { agentId: "worker", storePath: sourceStorePath, sessionKey: sourceKey },
        {
          sessionId: "source-session",
          lifecycleRevision: "source-incarnation",
          updatedAt: 1,
          spawnDepth: kind === "child" ? 1 : 0,
          parentSessionKey: parentKey,
          ...(kind === "child" ? { spawnedBy: parentKey } : {}),
        },
      );
      if (kind === "acp") {
        await upsertAcpSessionMeta({
          cfg: { ...cfg, session: { store: sourceStorePath } },
          agentId: "worker",
          sessionKey: sourceKey,
          env: state.env,
          mutate: () => ({
            backend: "acpx",
            agent: "worker",
            runtimeSessionName: sourceKey,
            mode: "persistent",
            state: "idle",
            lastActivityAt: 2,
          }),
        });
      }
      const context: AgentTurnContext = {
        addChatRun: vi.fn(),
        agentRunSeq: new Map(),
        broadcast: vi.fn(),
        broadcastToConnIds: vi.fn(),
        chatAbortControllers: new Map(),
        chatQueuedTurns: new Map(),
        chatRunState: createChatRunState(),
        dedupe: new Map(),
        deps: {},
        getRuntimeConfig: () => cfg,
        getSessionEventSubscriberConnIds: () => new Set(),
        loadGatewayModelCatalog: vi.fn(async () => []),
        loadGatewayModelCatalogSnapshot: vi.fn(),
        logGateway: createSubsystemLogger("test/source-lineage"),
        nodeSendToSession: vi.fn(),
        removeChatRun: vi.fn(() => undefined),
      };
      const result = prepareAgentRequestPreflight({
        request: {
          message: "Worker progress",
          sessionKey: parentKey,
          idempotencyKey: "coordination-run",
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: sourceKey,
            sourceTool: "sessions_send",
            sourceRole: "subagent",
          },
        },
        context,
        client: null,
        io: createAgentTurnIo(vi.fn()),
      });
      expect(result).toBeDefined();
      expect(result?.inputProvenance?.sourceRole).toBe(expectedRole);
    });
  },
);
