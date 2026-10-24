import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import * as diagnostics from "../../infra/diagnostics-timeline.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readResidentUserProfileIdentity } from "../../state/user-profile-list.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { requestHistory } from "./chat-history-fixtures.test-support.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

afterEach(() => vi.restoreAllMocks());

const scope = { agentId: "main", sessionKey: "agent:main:requester-history" };

type StartupReader = NonNullable<GatewayRequestContext["readChatStartupProjection"]>;

function withoutSqlite<T>(run: () => T): T {
  const sql = observeMainThreadSql();
  try {
    return run();
  } finally {
    const calls = sql.count();
    sql.restore();
    expect(calls).toBe(0);
  }
}

function adminClient(profileId: string) {
  const client = identifiedClient(profileId);
  client.connect.scopes = ["operator.admin"];
  return client;
}

async function request(context: GatewayRequestContext, client: GatewayClient) {
  const respond = await requestHistory("chat.startup", scope, context, client);
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ sessionId: "requester-history" }),
  );
  return respond;
}

it("prepares the startup requester without SQLite and observes a merge after history work", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const original = ensureProfileForEmail("original@example.test");
    const current = ensureProfileForEmail("current@example.test");
    await upsertSessionEntryCore(scope, { sessionId: "requester-history", updatedAt: 1 });
    const client = adminClient(original.id);
    const readStartup = vi.fn<StartupReader>(async () => undefined);
    const context = await createHistoryReadContext({ readChatStartupProjection: readStartup });
    let projections = 0;
    const measure = diagnostics.measureDiagnosticsTimelineSpan;
    let merged = false;
    vi.spyOn(diagnostics, "measureDiagnosticsTimelineSpan").mockImplementation(
      (name, run, options) => {
        if (name.endsWith(".history_page")) {
          return measure(name, run, options).then((page) => {
            if (!merged) {
              linkEmail("original@example.test", current.id);
              merged = true;
            }
            return page;
          });
        }
        if (!name.endsWith(".startup_projection")) {
          return measure(name, run, options);
        }
        // Only the synchronous metadata preparation is SQL-free, not transcript/sharing reads.
        projections++;
        return withoutSqlite(() => measure(name, run, options));
      },
    );
    const phases: Extract<DiagnosticEventPayload, { type: "diagnostic.phase.completed" }>[] = [];
    const stop = onTrustedInternalDiagnosticEvent(
      (event) => {
        if (event.type === "diagnostic.phase.completed") {
          phases.push(event);
        }
      },
      { include: ["diagnostic.phase.completed"] },
    );
    try {
      await request(context, client);
      await waitForDiagnosticEventsDrained();
    } finally {
      stop();
    }
    expect(phases.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "chat.startup.session_entry",
        "chat.startup.pending_inputs",
        "chat.startup.history_page",
        "chat.startup.startup_projection",
        "chat.startup.projection_final",
        "chat.startup.session_info",
      ]),
    );
    expect(phases.every(({ durationMs }) => durationMs !== undefined && durationMs >= 0)).toBe(
      true,
    );
    expect(phases.every(({ details }) => details === undefined)).toBe(true);
    expect(JSON.stringify(phases)).not.toContain("requester-history");
    expect(merged).toBe(true);
    expect(readStartup).toHaveBeenCalledOnce();
    const readParams = readStartup.mock.calls[0]![0];
    expect(readParams.readPolicy).toBe("current");
    withoutSqlite(() => expect(readParams.readRequesterProfileId?.()).toBe(current.id));
    expect(projections).toBe(1);
    vi.restoreAllMocks();
    for (const legacy of [false, true]) {
      const started = createDeferredCore();
      const resume = createDeferredCore();
      const changing = adminClient(original.id);
      if (legacy) {
        delete changing.authenticatedUserProfile;
        changing.authenticatedUserId = "original@example.test";
      }
      readStartup.mockImplementationOnce(async (prepared) => {
        started.resolve();
        await resume.promise;
        return {
          metadata: { swarmEnabled: false, commands: [prepared.readRequesterProfileId?.()] },
          sessionModelCatalog: [],
          defaultModelCatalog: [],
        };
      });
      const pending = request(context, changing);
      await started.promise;
      if (legacy) {
        changing.authenticatedUserId = "different@example.test";
      } else {
        changing.authenticatedUserProfile!.profileId = "different-profile";
      }
      resume.resolve();
      const response = await pending;
      expect(response.mock.calls[0]?.[1], legacy ? "legacy" : "attached").not.toHaveProperty(
        "metadata",
      );
    }
    getSessionRowProjection(context)?.dispose();
    withoutSqlite(() =>
      expect(() => readParams.readRequesterProfileId?.()).toThrow("catalog is not ready"),
    );
  });
});

it("preserves legacy email creation and failed identity synchronization", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const existing = ensureProfileForEmail("legacy@example.test");
    await upsertSessionEntryCore(scope, { sessionId: "requester-history", updatedAt: 1 });
    const readStartup = vi.fn<StartupReader>(async () => undefined);
    const context = await createHistoryReadContext({ readChatStartupProjection: readStartup });
    for (const kind of ["legacy", "missing", "github", "tailscale", "new"]) {
      const client = adminClient("missing-profile");
      client.authenticatedUserId = kind === "new" ? "new@example.test" : "legacy@example.test";
      if (kind !== "missing") {
        delete client.authenticatedUserProfile;
      }
      const sync = vi
        .fn<NonNullable<GatewayClient["authenticatedGitHubIdentitySync"]>>()
        .mockRejectedValue(new Error("unexpected identity synchronization"));
      if (kind === "github") {
        client.authenticatedGitHubIdentitySync = sync;
      }
      if (kind === "tailscale") {
        client.authenticatedUserIsTailscaleProvider = true;
      }
      readStartup.mockClear();
      await request(context, client);
      expect(readStartup, kind).toHaveBeenCalledOnce();
      const observedId = readStartup.mock.calls[0]![0].readRequesterProfileId?.();
      if (kind === "new") {
        expect(observedId).toEqual(expect.any(String));
        expect(ensureProfileForEmail("new@example.test").id).toBe(observedId);
      } else {
        expect(observedId, kind).toBe(kind === "legacy" ? existing.id : undefined);
      }
      expect(sync, kind).not.toHaveBeenCalled();
      expect(readResidentUserProfileIdentity("missing-profile"), kind).toBeUndefined();
    }
  });
});
