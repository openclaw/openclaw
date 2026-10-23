import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { createControlUiTeamScaleFixture } from "../../ui/src/test-helpers/control-ui-team-scale-fixture.js";
import {
  assignSessionOwner,
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { listSessions, requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import type { SessionsListResult } from "./session-utils.types.js";

afterEach(() => vi.restoreAllMocks());

it("retains 25 readers' ten Team-scale queries and reports bounded reference cost", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fixture = createControlUiTeamScaleFixture({ now });
    const context = requestContext(rolePolicyConfig());
    const clients = Array.from({ length: 25 }, (_, index) => roleClient("view", `scale-${index}`));
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    clients.forEach((client) => prepareGatewayRecipientProfile(client));
    // This retention scenario owns 300 roots; reload fixtures also include child and cron rows.
    const rows = fixture.scenario.sessions!.slice(0, 300);
    const owner = (index: number) => ({
      type: "human" as const,
      id: clients[index % 25]!.authenticatedUserProfile!.profileId,
    });
    for (const [index, row] of rows.entries()) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: row.key },
        {
          sessionId: row.sessionId!,
          updatedAt: row.updatedAt ?? now,
          label: typeof row.label === "string" ? row.label : undefined,
          createdAt: typeof row.createdAt === "number" ? row.createdAt : undefined,
          pinnedAt: row.pinnedAt,
          visibility: "shared",
          spawnedBy: index >= 2 && index < 12 ? rows[index % 2]!.key : undefined,
          createdActor: { ...owner(index), source: "profile" },
        },
      );
      assignSessionOwner(
        { agentId: "main", sessionKey: row.key },
        { owner: owner(index), assignedBy: owner(0) },
      );
    }
    let retained = { views: 0, refs: 0, estimatedBytes: 0 };
    const stop = onTrustedInternalDiagnosticEvent((event) => {
      if (event.type === "sessions.list.retention") {
        retained = { views: event.views, refs: event.refs, estimatedBytes: event.estimatedBytes };
      }
    });
    const report = async (stage: string) => {
      await setImmediate();
      await waitForDiagnosticEventsDrained();
      console.log(`TEAM_VIEW_RETENTION_${stage}`, JSON.stringify(retained));
    };
    const read = (
      client: (typeof clients)[number],
      query: SessionsListParams,
      base?: SessionsListResult,
    ) =>
      listSessions({
        context,
        client,
        acceptsSerializedJson: true,
        request: {
          agentId: "main",
          rowMode: "sidebar",
          ...query,
          ifRowsRevision: base && `delta:${base.rowsRevision}`,
        },
      });
    const release = retainSessionListForegroundWork();
    try {
      const general = await read(clients[0]!, { limit: 300 });
      const reread: (() => Promise<SessionsListResult>)[] = [];
      expect(general.count).toBe(300);
      await report("SINGLE_QUERY");
      const scope = { agentId: "main", sessionKey: rows[0]!.key };
      for (let revision = 0; revision < 32; revision++) {
        replaceSessionEntrySync(scope, {
          ...loadSessionEntry(scope)!,
          label: `Revision ${revision}`,
        });
        expect((await read(clients[0]!, { limit: 300 }, general)).rowsDelta?.baseRevision).toBe(
          general.rowsRevision,
        );
      }
      await report("SINGLE_QUERY_32_GENERATIONS");
      for (const client of clients) {
        const queries: SessionsListParams[] = [
          { limit: 200 },
          { limit: 300 },
          { involvingMe: true },
          { ownerId: client.authenticatedUserProfile!.profileId },
          { includeOwnerSessionCounts: true },
          { pinned: true },
          { archived: "all" },
          { sortBy: "activity" },
          { spawnedBy: rows[0]!.key },
          { spawnedBy: rows[1]!.key },
        ];
        for (const query of queries) {
          const result = await read(client, query);
          if (query.limit === 300) {
            expect(result.count).toBe(300);
          }
          if (query.ownerId || query.involvingMe) {
            expect(result.count).toBe(12);
          }
          reread.push(() => read(client, query, result));
        }
        if (client === clients[0]) {
          await report("ONE_READER");
        }
      }
      await report("25_READERS");
      expect(retained.views).toBeGreaterThan(32);
      expect(retained.estimatedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
      for (const repeat of reread) {
        expect(await repeat()).toMatchObject({ rowsUnchanged: true });
      }
    } finally {
      getSessionRowProjection(context)?.dispose();
      release();
      await setImmediate();
      await waitForDiagnosticEventsDrained();
      stop();
    }
    expect(retained).toMatchObject({ views: 0, refs: 0, estimatedBytes: 0 });
  });
});
