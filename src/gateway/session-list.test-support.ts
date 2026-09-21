import { expectDefined } from "@openclaw/normalization-core";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../agents/agent-scope-config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { readUserProfileAliases } from "../state/user-profile-list.js";
import { readSessionRowFacts } from "./server-methods/session-placement-read-projection.js";
import type { GatewayClient } from "./server-methods/types.js";
import type { SessionListDiagnostics } from "./session-list-diagnostics.types.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";

type SessionListProjectionTiming = Pick<
  SessionListDiagnostics["projection"],
  "prepareSyncMs" | "rowSyncMs" | "yieldWaitMs" | "yieldCount"
>;

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

function sessionStoreTargetsFixture(params: {
  cfg: OpenClawConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  agentId?: string;
}) {
  const readSourceEntry = (key: string) => params.store[key];
  return new Map(
    Object.entries(params.store).map(([key, entry]) => {
      const agentId = fixtureOwner(params.cfg, key, params.agentId);
      return [
        key,
        {
          agentId,
          storeTarget: { agentId, storePath: params.storePath },
          entry,
          readSourceEntry,
        },
      ] as const;
    }),
  );
}

/** Synthetic stores declare ownership and caller facts before invoking the shared list path. */
export async function listSessionFixture(
  params: Parameters<typeof createSessionRowProjectionFixture>[0] & {
    storePath: string;
    opts: SessionsListParams;
    fixtureAgentId?: string;
    entryFilter?: (key: string, entry: SessionEntry) => boolean;
    ownerFirstActorId?: string;
    involvingActorId?: string;
    workStartedAt?: number;
    projectionTiming?: SessionListProjectionTiming;
  },
) {
  const store = params.entryFilter
    ? Object.fromEntries(
        Object.entries(params.store).filter(([key, entry]) => params.entryFilter!(key, entry)),
      )
    : params.store;
  const projection = createSessionRowProjectionFixture({
    ...params,
    store,
    targetsBySessionKey:
      params.targetsBySessionKey ??
      sessionStoreTargetsFixture({
        ...params,
        store,
        agentId: params.opts.agentId ?? params.fixtureAgentId,
      }),
  });
  if (params.opts.includeActivitySummary) {
    for (const row of projection.selectEntries()) {
      row.facts = readSessionRowFacts({ cfg: params.cfg, target: row, entry: row.entry });
      row.hasBoard = row.facts.hasBoard;
    }
  }
  const profileId = params.ownerFirstActorId ?? params.involvingActorId;
  const client: GatewayClient | undefined =
    profileId || params.entryFilter
      ? {
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            client: {
              id: "openclaw-control-ui",
              version: "test",
              platform: "test",
              mode: "webchat",
            },
            role: "operator",
            scopes: ["operator.admin"],
          },
          ...(profileId
            ? {
                authenticatedUserProfile: {
                  profileId,
                  displayName: profileId,
                  hasAvatar: false,
                  updatedAt: 1,
                },
                preparedSessionProfile: {
                  profileId,
                  aliases: readUserProfileAliases(profileId),
                  role: null,
                },
              }
            : {}),
        }
      : undefined;
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
