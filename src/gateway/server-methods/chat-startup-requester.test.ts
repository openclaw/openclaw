import { DatabaseSync, StatementSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as diagnostics from "../../infra/diagnostics-timeline.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readUserProfileIdentity } from "../../state/user-profile-list.js";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

afterEach(() => vi.restoreAllMocks());

const scope = { agentId: "main", sessionKey: "agent:main:requester-history" };

async function request(
  method: "chat.history" | "chat.startup",
  context: GatewayRequestContext,
  client: GatewayClient,
) {
  const respond = vi.fn<RespondFn>();
  await expectDefined(
    chatHistoryHandlers[method],
    "history handler",
  )({
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
    const original = ensureProfileForEmail("original@example.test");
    const current = ensureProfileForEmail("current@example.test");
    await upsertSessionEntryCore(scope, { sessionId: "requester-history", updatedAt: 1 });
    const client = identifiedClient(original.id);
    client.connect.scopes = ["operator.admin"];
    const readChatStartupProjection = vi.fn<
      NonNullable<GatewayRequestContext["readChatStartupProjection"]>
    >(async () => undefined);
    const context = await createHistoryReadContext({ readChatStartupProjection });
    const measuredStatements: number[] = [];
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
        // Count execution, including already-prepared data_version statements, before
        // the metadata callback yields. Transcript and sharing reads retain their owners.
        const statements = [
          vi.spyOn(DatabaseSync.prototype, "exec"),
          ...(["all", "get", "iterate", "run"] as const).map((operation) =>
            vi.spyOn(StatementSync.prototype, operation),
          ),
        ];
        try {
          const result = measure(name, run, options);
          measuredStatements.push(
            statements.reduce((count, statement) => count + statement.mock.calls.length, 0),
          );
          return result;
        } finally {
          for (const statement of statements) {
            statement.mockRestore();
          }
        }
      },
    );
    await request("chat.startup", context, client);
    expect(merged).toBe(true);
    expect(readChatStartupProjection).toHaveBeenCalledOnce();
    const readParams = readChatStartupProjection.mock.calls[0]![0];
    expect(readParams.readPolicy).toBe("current");
    const statements = vi.spyOn(StatementSync.prototype, "get");
    expect(readParams.readRequesterProfileId?.()).toBe(current.id);
    expect(statements).not.toHaveBeenCalled();
    statements.mockRestore();
    expect(measuredStatements).toEqual([0]);
    vi.restoreAllMocks();
    for (const legacy of [false, true]) {
      const started = createDeferredCore();
      const resume = createDeferredCore();
      const changingClient = identifiedClient(original.id);
      changingClient.connect.scopes = ["operator.admin"];
      if (legacy) {
        delete changingClient.authenticatedUserProfile;
        changingClient.authenticatedUserId = "original@example.test";
      }
      readChatStartupProjection.mockImplementationOnce(async (prepared) => {
        started.resolve();
        await resume.promise;
        return {
          metadata: { swarmEnabled: false, commands: [prepared.readRequesterProfileId?.()] },
          sessionModelCatalog: [],
          defaultModelCatalog: [],
        };
      });
      const pending = request("chat.startup", context, changingClient);
      await started.promise;
      if (legacy) {
        changingClient.authenticatedUserId = "different@example.test";
      } else {
        changingClient.authenticatedUserProfile!.profileId = "different-profile";
      }
      resume.resolve();
      const response = await pending;
      expect(response.mock.calls[0]?.[1], legacy ? "legacy" : "attached").not.toHaveProperty(
        "metadata",
      );
    }
    getSessionRowProjection(context)?.dispose();
    const unavailable = vi.spyOn(StatementSync.prototype, "get");
    expect(() => readParams.readRequesterProfileId?.()).toThrow("catalog is not ready");
    expect(unavailable).not.toHaveBeenCalled();
  });
});

it("preserves legacy email creation and failed identity synchronization", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const existing = ensureProfileForEmail("legacy@example.test");
    await upsertSessionEntryCore(scope, { sessionId: "requester-history", updatedAt: 1 });
    const readChatStartupProjection = vi.fn<
      NonNullable<GatewayRequestContext["readChatStartupProjection"]>
    >(async () => undefined);
    const context = await createHistoryReadContext({ readChatStartupProjection });
    for (const kind of [
      "legacy email",
      "missing profile",
      "github sync",
      "tailscale sync",
      "new email",
    ]) {
      const client = identifiedClient("missing-profile");
      client.connect.scopes = ["operator.admin"];
      client.authenticatedUserId =
        kind === "new email" ? "new@example.test" : "legacy@example.test";
      if (kind !== "missing profile") {
        delete client.authenticatedUserProfile;
      }
      const sync = vi.fn<NonNullable<GatewayClient["authenticatedGitHubIdentitySync"]>>(
        async () => {
          throw new Error("unexpected identity synchronization");
        },
      );
      if (kind === "github sync") {
        client.authenticatedGitHubIdentitySync = sync;
      }
      if (kind === "tailscale sync") {
        client.authenticatedUserIsTailscaleProvider = true;
      }
      readChatStartupProjection.mockClear();
      await request("chat.startup", context, client);
      expect(readChatStartupProjection, kind).toHaveBeenCalledOnce();
      const observedId = readChatStartupProjection.mock.calls[0]![0].readRequesterProfileId?.();
      if (kind === "new email") {
        expect(observedId).toEqual(expect.any(String));
        expect(ensureProfileForEmail("new@example.test").id).toBe(observedId);
      } else {
        expect(observedId, kind).toBe(kind === "legacy email" ? existing.id : undefined);
      }
      expect(sync, kind).not.toHaveBeenCalled();
      expect(readUserProfileIdentity("missing-profile"), kind).toBeUndefined();
    }
  });
});
