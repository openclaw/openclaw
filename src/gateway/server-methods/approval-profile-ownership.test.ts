import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import type { ExecApprovalRecord } from "../exec-approval-manager.js";
import { createOperatorApprovalSessionEventRuntime } from "../operator-approval-session-events.js";
import {
  createPendingRecord,
  createTerminalRecord,
} from "../operator-approval-session-events.test-support.js";
import { createSessionMessageSubscriberRegistry } from "../server-chat-state.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import { prepareSessionSharing } from "../session-sharing-read.js";
import type { SessionSharingTarget } from "../session-sharing-target.types.js";
import {
  canAccessApprovalSession,
  isApprovalRecordVisibleToClient,
  readOperatorApprovalRequestSource,
} from "./approval-record-lookup.js";
import { bindApprovalRequesterMetadata } from "./approval-shared.js";
import { createClient } from "./approval.handlers.test-support.js";
import type { GatewayClient } from "./types.js";

const sessionKey = "agent:main:approval-profile";
const target: SessionSharingTarget = {
  agentId: "main",
  canonicalKey: sessionKey,
  storeKey: sessionKey,
  storeKeys: [sessionKey],
  storePath: "",
  entry: {
    sessionId: "profile-test",
    updatedAt: 1,
    createdActor: { type: "human", source: "profile", id: "creator" },
  },
};
function client(profileId: string, scopes = ["operator.approvals"]) {
  return {
    ...createClient({ connId: profileId, deviceId: profileId, scopes }),
    preparedSessionProfile: { profileId, aliases: new Set([profileId]), role: null },
    authenticatedUserProfile: { profileId, displayName: null, hasAvatar: false, updatedAt: 0 },
  } as GatewayClient;
}
function roleConfig(cap: "invited" | "view" | "suggest" | "write" = "invited"): OpenClawConfig {
  return {
    agents: { entries: { main: {} } },
    gateway: {
      roles: {
        default: "member",
        definitions: {
          member: {
            agents: "*",
            scopes: ["operator.read", "operator.approvals"],
            sessions: { others: cap },
          },
        },
      },
    },
  };
}
afterEach(() => clearRuntimeConfigSnapshot());

describe("approval profile ownership", () => {
  it.each(["invited", "view", "suggest", "write"] as const)(
    "applies requester filtering only to sessions.others=%s invitation access",
    (cap) => {
      const reviewer = client("member");
      const cfg = roleConfig(cap);
      const prepared = {
        sharing: prepareSessionSharing(
          { cfg, client: reviewer },
          {
            aliases: new Set(["member"]),
            sessionCap: cap,
            isMember: () => true,
          },
        ),
        target: () => target,
      };
      const access = (requestedByProfileId?: string) =>
        canAccessApprovalSession({
          client: reviewer,
          cfg,
          sessionKey,
          requestedByProfileId,
          prepared,
        });
      expect(access("other")).toBe(cap !== "invited");
      expect(access()).toBe(cap !== "invited");
      expect(access("member")).toBe(true);
      expect(
        canAccessApprovalSession({
          client: reviewer,
          cfg,
          sessionKey,
          requestedByProfileId: "member",
        }),
      ).toBe(cap !== "invited");
    },
  );

  it("preserves the profiled gateway owner's main approval visibility", () => {
    const owner = client("gateway-owner");
    const prepared = {
      sharing: prepareSessionSharing({ cfg: {}, client: owner }),
      target: () => target,
    };
    const access = (requestedByProfileId?: string, current = target) =>
      canAccessApprovalSession({
        client: owner,
        cfg: {},
        sessionKey,
        requestedByProfileId,
        prepared: { ...prepared, target: () => current },
      });
    expect(access("gateway-owner")).toBe(true);
    expect(access("other")).toBe(true);
    expect(access()).toBe(true);
    expect(
      access(undefined, {
        ...target,
        entry: {
          ...target.entry,
          createdActor: { type: "human", source: "profile", id: "gateway-owner" },
        },
      }),
    ).toBe(true);
  });

  it("allows creators and admins, but not human device matches, for unattributed approvals", () => {
    const cfg = roleConfig();
    const prepared = {
      sharing: prepareSessionSharing(
        { cfg, client: client("creator") },
        { aliases: new Set(["creator"]), sessionCap: "invited", isMember: () => true },
      ),
      target: () => target,
    };
    for (const reviewer of [client("creator"), client("admin", ["operator.admin"])]) {
      expect(canAccessApprovalSession({ client: reviewer, cfg, sessionKey, prepared })).toBe(true);
    }
    const record: ExecApprovalRecord = {
      id: "missing-raiser",
      request: { command: "secret", sessionKey },
      createdAtMs: 1,
      expiresAtMs: 2,
      requestedByConnId: "member",
      requestedByDeviceId: "member",
    };
    expect(
      isApprovalRecordVisibleToClient({
        client: client("member"),
        record,
        cfg,
        prepared: {
          ...prepared,
          sharing: prepareSessionSharing(
            { cfg, client: client("member") },
            { aliases: new Set(["member"]), sessionCap: "invited", isMember: () => true },
          ),
        },
      }),
    ).toBe(false);
  });

  it("binds the actual authority rather than payload, UI-routing, or synthetic client claims", () => {
    const record: ExecApprovalRecord = {
      id: "bound",
      request: { command: "ok", sessionKey },
      createdAtMs: 1,
      expiresAtMs: 2,
    };
    Object.assign(record.request, { requestedByProfileId: "spoofed" });
    const requester = client("synthetic");
    requester.internal = {
      operatorRunAuthority: createAdmittedRunOperatorAuthority({
        profileId: "actual-turn",
        scopes: ["operator.approvals"],
        assertCurrent() {},
      }),
    };
    bindApprovalRequesterMetadata({ record, client: requester });
    expect(record.requestedByProfileId).toBe("actual-turn");
    bindApprovalRequesterMetadata({ record });
    expect(record.requestedByProfileId).toBeNull();
    const durable = createPendingRecord();
    durable.requester.profileId = "actual-turn";
    expect(readOperatorApprovalRequestSource(durable).requestedByProfileId).toBe("actual-turn");
  });

  it("derives signed runtime provenance from the admitted turn, not caller-supplied IDs", async () => {
    const prepared = prepareSystemAgentRunAdmission(
      {},
      "approval-profile-run",
      "main",
      "test",
      undefined,
      createAdmittedRunOperatorAuthority({
        profileId: "admitted-profile",
        scopes: ["operator.approvals"],
        assertCurrent() {},
      }),
    );
    try {
      const admitted = await prepared.admit("embedded");
      const input = {
        agentId: "main",
        sessionKey,
        operationalRunInstance: admitted.operationalRunInstance,
        approvalRequesterProfileId: "spoofed",
        gatewayUiCommandTarget: { connId: "ui", profileId: "routing-only" },
      };
      expect(await createAgentRuntimeIdentity(input)).toMatchObject({
        approvalRequesterProfileId: "admitted-profile",
      });
    } finally {
      prepared.close();
    }
  });

  it("filters requested and resolved session events by source creator or raiser", () => {
    const cfg = roleConfig();
    setRuntimeConfigSnapshot(cfg);
    const projection = createSessionRowProjectionFixture({
      cfg,
      store: { [sessionKey]: target.entry },
    });
    Object.assign(
      expectDefined(
        projection.describe({ agentId: "main", key: sessionKey }),
        "materialized session",
      ),
      {
        membership: new Set(["raiser", "unrelated"]),
      },
    );
    const clients = [
      client("creator"),
      client("raiser"),
      client("unrelated"),
      client("admin", ["operator.admin"]),
    ];
    const subscribers = createSessionMessageSubscriberRegistry();
    for (const reviewer of clients) {
      subscribers.subscribe(reviewer.connId!, sessionKey, { includeApprovals: true });
    }
    const audiences: Set<string>[] = [];
    const runtime = createOperatorApprovalSessionEventRuntime({
      clients: new Set(clients),
      sessionMessageSubscribers: subscribers,
      getSessionRowProjection: () => projection,
      broadcastToConnIds: (_event, _payload, ids) => {
        audiences.push(new Set(ids));
      },
    });
    const record = createPendingRecord({
      sourceSessionKey: sessionKey,
      audienceSessionKeys: [sessionKey],
      reviewerDeviceIds: [],
    });
    record.requester.profileId = "raiser";
    runtime.publish({ phase: "pending", record });
    runtime.publish({ phase: "terminal", record: createTerminalRecord(record) });
    expect(audiences).toEqual([
      new Set(["creator", "raiser", "admin"]),
      new Set(["creator", "raiser", "admin"]),
    ]);
    delete record.requester.profileId;
    runtime.publish({ phase: "pending", record: { ...record, id: "unattributed" } });
    expect(audiences.at(-1)).toEqual(new Set(["creator", "admin"]));
    projection.dispose();
  });
});
