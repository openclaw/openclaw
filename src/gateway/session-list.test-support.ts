import { expectDefined } from "@openclaw/normalization-core";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { prepareSubagentSessionListReadCache } from "../agents/subagents/registry/subagent-registry-state.js";
import type { SessionEntry } from "../config/sessions.js";
import { readSessionActivitySummary } from "../config/sessions/activity-summary.js";
import { readSessionTranscriptWatermarkAsync } from "../config/sessions/session-transcript-watermark.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { prepareUserProfileCatalog, readUserProfileAliases } from "../state/user-profile-list.js";
import { readSessionRowFacts } from "./server-methods/session-placement-read-projection.js";
import type { GatewayClient } from "./server-methods/types.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";

function fixtureOwner(cfg: OpenClawConfig, key: string, agentId?: string): string {
  const configured = listAgentIds(cfg);
  return expectDefined(
    parseAgentSessionKey(key)?.agentId ??
      agentId ??
      (key !== "global" && key !== "unknown" && configured.length === 1
        ? configured[0]
        : undefined),
    `fixture owner for ${key}`,
  );
}

export function buildSessionRowFixture(
  params: Omit<Parameters<typeof buildGatewaySessionRow>[0], "agentId"> & { agentId?: string },
) {
  return buildGatewaySessionRow({
    ...params,
    agentId: fixtureOwner(params.cfg, params.key, params.agentId),
  });
}

export async function listSessionFixture(
  params: Parameters<typeof createSessionRowProjectionFixture>[0] & {
    storePath: string;
    opts: SessionsListParams;
    fixtureAgentId?: string;
    entryFilter?: (key: string, entry: SessionEntry) => boolean;
    ownerFirstActorId?: string;
    involvingActorId?: string;
  },
) {
  await prepareSubagentSessionListReadCache();
  using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
  const store = params.entryFilter
    ? Object.fromEntries(
        Object.entries(params.store).filter(([key, entry]) => params.entryFilter!(key, entry)),
      )
    : params.store;
  const agentId = params.opts.agentId ?? params.fixtureAgentId;
  if (!params.targetsBySessionKey) {
    // Keep the strict ownership check; the projection fixture builds identical default targets.
    for (const key of Object.keys(store)) {
      fixtureOwner(params.cfg, key, agentId);
    }
  }
  const projection = createSessionRowProjectionFixture({
    ...params,
    store,
    ...(params.targetsBySessionKey ? {} : { agentId }),
  });
  if (params.opts.includeActivitySummary) {
    for (const row of projection.selectEntries()) {
      row.facts = readSessionRowFacts({
        cfg: params.cfg,
        target: row,
        entry: row.entry,
        databaseFacts: {
          hasBoard: row.hasBoard ?? false,
          activitySummaryWatermark: readSessionActivitySummary(row.entry)
            ? await readSessionTranscriptWatermarkAsync({
                agentId: row.agentId,
                sessionKey: row.key,
                sessionId: row.entry.sessionId,
                storePath: row.storeTarget.storePath,
              })
            : undefined,
        },
      });
      row.hasBoard = row.facts.hasBoard;
    }
  }
  const profileId = params.ownerFirstActorId ?? params.involvingActorId;
  let client: GatewayClient | undefined;
  if (profileId || params.entryFilter) {
    client = {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
        role: "operator",
        scopes: ["operator.admin"],
      },
    };
    if (profileId) {
      client.authenticatedUserProfile = {
        profileId,
        displayName: profileId,
        hasAvatar: false,
        updatedAt: 1,
      };
      client.preparedSessionProfile = {
        profileId,
        aliases: readUserProfileAliases(profileId),
        role: null,
      };
    }
  }
  try {
    return await listProjectedSessions({
      projection,
      client,
      opts: {
        ...params.opts,
        ownerFirst: Boolean(params.ownerFirstActorId),
        involvingMe: Boolean(params.involvingActorId),
      },
    });
  } finally {
    projection.dispose();
  }
}
