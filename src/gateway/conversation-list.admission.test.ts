import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  listConversations,
  prepareConversationRegistryScope,
} from "../config/sessions/conversation-registry.js";
import { listSessionEntriesCore } from "../config/sessions/session-accessor.entry.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as channelResolution from "../infra/outbound/channel-resolution.js";
import * as outboundSession from "../infra/outbound/outbound-session.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { runGatewayConversationList } from "./conversation-list.js";
import * as routeOwnership from "./conversation-route-ownership.js";

const tempDirs = createTempDirTracker();
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

async function createDirectory(
  params: { agentId?: string; physicalAgentId?: string; peerIds?: string[] } = {},
) {
  const agentId = params.agentId ?? "main";
  const stateDir = tempDirs.make("conversation-directory-admission-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const storePath = path.join(stateDir, "directory.sqlite");
  openOpenClawAgentDatabase({ agentId: params.physicalAgentId ?? agentId, path: storePath });
  const config: OpenClawConfig = {
    agents: { entries: { [agentId]: {} } },
    session: { store: storePath },
  };
  const scope = await prepareConversationRegistryScope({ config, agentId });
  const routed = createDeferredCore();
  vi.spyOn(channelResolution, "resolveOutboundChannelPlugin").mockImplementation(() => ({
    ...createChannelTestPluginBase({ id: "reef" }),
    directory: {
      listPeers: async () =>
        (params.peerIds ?? ["peer"]).map((id) => ({ kind: "user" as const, id })),
    },
  }));
  const resolveRoute = async ({ target }: { target: string }) => {
    routed.resolve();
    return {
      sessionKey: `agent:${agentId}:reef:direct:${target}`,
      baseSessionKey: `agent:${agentId}:reef:direct:${target}`,
      peer: { kind: "direct" as const, id: target },
      chatType: "direct" as const,
      from: `reef:${target}`,
      to: `reef:${target}`,
    };
  };
  const route = vi
    .spyOn(outboundSession, "resolveOutboundSessionRoute")
    .mockImplementation(resolveRoute);
  const list = (overrides: Partial<Parameters<typeof runGatewayConversationList>[0]> = {}) =>
    runGatewayConversationList({ config, agentId, channel: "reef", limit: 10, ...overrides });
  const expectStored = async (count: number) => {
    expect(await listConversations(scope)).toHaveLength(count);
    expect(listSessionEntriesCore(scope)).toEqual([]);
  };
  return { config, route, resolveRoute, routed, scope, storePath, list, expectStored };
}

describe("conversation directory write admission", () => {
  it.each(["eligible", "denied", "unavailable"] as const)(
    "rechecks route ownership after waiting for the writer: %s",
    async (eligibility) => {
      const peerIds = ["peer", "peer-two", "peer-three"];
      const fixture = await createDirectory({ peerIds });
      let currentConfig = fixture.config;
      const release = createDeferredCore();
      const blocker = runOpenClawAgentWriteAdmission(
        toDatabaseOptions(resolveSqliteReadScope(fixture.scope)),
        () => release.promise,
      );
      const settled = vi.fn();
      let forcedUnavailable = false;
      const prepare = routeOwnership.prepareConversationRouteEligibilitiesForAgent;
      vi.spyOn(routeOwnership, "prepareConversationRouteEligibilitiesForAgent").mockImplementation(
        async (input) => {
          const prepared = await prepare(input);
          return {
            ...prepared,
            read: () =>
              forcedUnavailable
                ? input.conversations.map(() => "unavailable" as const)
                : prepared.read(),
          };
        },
      );
      const result = fixture
        .list({ readCurrentConfig: () => currentConfig })
        .catch((error: unknown) => error)
        .finally(settled);
      try {
        await fixture.routed.promise;
        await setImmediate();
        expect(settled).not.toHaveBeenCalled();
        expect(await listConversations(fixture.scope)).toEqual([]);
        if (eligibility === "denied") {
          currentConfig = {
            ...fixture.config,
            agents: { entries: { main: {}, finance: {} } },
            bindings: [{ type: "route", agentId: "finance", match: { channel: "reef" } }],
          };
        } else if (eligibility === "unavailable") {
          forcedUnavailable = true;
        }
        release.resolve();
        await blocker;
        if (eligibility === "unavailable") {
          await expect(result).resolves.toEqual(
            new Error("Conversation route ownership is temporarily unavailable"),
          );
        } else {
          const conversations =
            eligibility === "eligible"
              ? expect.arrayContaining(
                  peerIds.map((id) => expect.objectContaining({ target: `reef:${id}` })),
                )
              : [];
          await expect(result).resolves.toMatchObject({ conversations });
        }
        await fixture.expectStored(eligibility === "eligible" ? peerIds.length : 0);
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
      const fixture = await createDirectory({
        agentId: "logical-agent",
        physicalAgentId: "schema-owner",
      });
      const releaseRoute = createDeferredCore();
      fixture.route.mockImplementation(async (params) => {
        const route = await fixture.resolveRoute(params);
        await releaseRoute.promise;
        return route;
      });
      const config = {
        ...fixture.config,
        session: { store: path.basename(fixture.storePath) },
      };
      const result = fixture.list({ config });
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
        await fixture.expectStored(1);
      } finally {
        releaseRoute.resolve();
        await result;
      }
    },
  );
});
