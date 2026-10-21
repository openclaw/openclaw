import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as diagnostics from "../../infra/diagnostics-timeline.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readResidentUserProfileIdentity } from "../../state/user-profile-list.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

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
  const method = "chat.startup";
  const respond = vi.fn<RespondFn>();
  const handler = expectDefined(chatHistoryHandlers[method], "history handler");
  await handler({
    params: scope,
    client,
    context,
    respond,
    req: { type: "req", id: "requester-history", method },
    isWebchatConnect: () => false,
  });
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
    await request(context, client);
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
