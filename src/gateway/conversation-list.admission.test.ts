import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  listConversations,
  registerConversationAddresses,
  resolveConversationRegistryScope,
} from "../config/sessions/conversation-registry.js";
import { listSessionEntriesCore } from "../config/sessions/session-accessor.entry.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { runGatewayConversationList } from "./conversation-list.js";
import * as routeOwnership from "./conversation-route-ownership.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createDirectory(params: { agentId?: string; physicalAgentId?: string } = {}) {
  const agentId = params.agentId ?? "main";
  const stateDir = tempDirs.make("conversation-directory-admission-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const storePath = path.join(stateDir, "directory.sqlite");
  openOpenClawAgentDatabase({ agentId: params.physicalAgentId ?? agentId, path: storePath });
  const config: OpenClawConfig = {
    agents: { entries: { [agentId]: {} } },
    session: { store: storePath },
  };
  const scope = resolveConversationRegistryScope({ config, agentId });
  const routed = createDeferredCore();
  const deps = {
    listConversations,
    registerConversationAddresses,
    resolveOutboundChannelPlugin: () => ({
      ...createChannelTestPluginBase({ id: "reef" }),
      directory: {
        listPeers: async () => [{ kind: "user" as const, id: "peer", name: "Synthetic peer" }],
      },
    }),
    resolveOutboundSessionRoute: async () => {
      routed.resolve();
      return {
        sessionKey: `agent:${agentId}:reef:direct:peer`,
        baseSessionKey: `agent:${agentId}:reef:direct:peer`,
        peer: { kind: "direct" as const, id: "peer" },
        chatType: "direct" as const,
        from: "reef:peer",
        to: "reef:peer",
      };
    },
  };
  return { agentId, config, deps, routed, scope, stateDir, storePath };
}

describe("conversation directory write admission", () => {
  it.each(["eligible", "denied", "unavailable"] as const)(
    "rechecks route ownership after waiting for the writer: %s",
    async (eligibility) => {
      const fixture = createDirectory();
      let currentConfig = fixture.config;
      const release = createDeferredCore();
      const blocker = runOpenClawAgentWriteAdmission(
        toDatabaseOptions(resolveSqliteReadScope(fixture.scope)),
        () => release.promise,
      );
      let settled = false;
      const result = runGatewayConversationList(
        {
          config: fixture.config,
          readCurrentConfig: () => currentConfig,
          agentId: fixture.agentId,
          channel: "reef",
          limit: 10,
        },
        fixture.deps,
      ).then(
        (value) => {
          settled = true;
          return { value };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        },
      );
      try {
        await fixture.routed.promise;
        await setImmediate();
        expect(settled).toBe(false);
        expect(listConversations(fixture.scope)).toEqual([]);
        if (eligibility === "denied") {
          currentConfig = {
            ...fixture.config,
            agents: { entries: { main: {}, finance: {} } },
            bindings: [{ type: "route", agentId: "finance", match: { channel: "reef" } }],
          };
        } else if (eligibility === "unavailable") {
          vi.spyOn(routeOwnership, "resolveConversationRouteEligibilityForAgent").mockReturnValue(
            "unavailable",
          );
        }
        release.resolve();
        await blocker;
        if (eligibility === "unavailable") {
          await expect(result).resolves.toEqual({
            error: new Error("Conversation route ownership is temporarily unavailable"),
          });
        } else {
          await expect(result).resolves.toMatchObject({
            value: {
              conversations:
                eligibility === "eligible"
                  ? [expect.objectContaining({ target: "reef:peer" })]
                  : [],
            },
          });
        }
        expect(listConversations(fixture.scope)).toHaveLength(eligibility === "eligible" ? 1 : 0);
        expect(listSessionEntriesCore(fixture.scope)).toEqual([]);
      } finally {
        release.resolve();
        await blocker;
        await result;
      }
    },
  );

  it.each(["environment", "working directory"] as const)(
    "keeps a shared physical store and logical route when the %s changes during discovery",
    async (changed) => {
      const fixture = createDirectory({
        agentId: "logical-agent",
        physicalAgentId: "schema-owner",
      });
      const releaseRoute = createDeferredCore();
      const routed = fixture.deps.resolveOutboundSessionRoute;
      fixture.deps.resolveOutboundSessionRoute = async () => {
        const route = await routed();
        await releaseRoute.promise;
        return route;
      };
      const config = {
        ...fixture.config,
        session: { store: path.relative(process.cwd(), fixture.storePath) },
      };
      const result = runGatewayConversationList(
        { config, agentId: fixture.agentId, channel: "reef", limit: 10 },
        fixture.deps,
      );
      try {
        await fixture.routed.promise;
        const otherDirectory = tempDirs.make("conversation-directory-moved-");
        if (changed === "environment") {
          vi.stubEnv("OPENCLAW_STATE_DIR", otherDirectory);
        } else {
          vi.spyOn(process, "cwd").mockReturnValue(otherDirectory);
        }
        releaseRoute.resolve();
        await expect(result).resolves.toMatchObject({
          conversations: [expect.objectContaining({ target: "reef:peer" })],
        });
        expect(listConversations(fixture.scope)).toHaveLength(1);
        expect(listSessionEntriesCore(fixture.scope)).toEqual([]);
      } finally {
        releaseRoute.resolve();
        await result;
      }
    },
  );
});
