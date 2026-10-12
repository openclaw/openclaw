import { DatabaseSync, StatementSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as diagnostics from "../../infra/diagnostics-timeline.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

afterEach(() => vi.restoreAllMocks());

it("reads prepared history catalogs without querying the unused requester identity", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const profile = ensureProfileForEmail("history@example.test");
    const scope = { agentId: "main", sessionKey: "agent:main:requester-history" };
    await upsertSessionEntryCore(scope, { sessionId: "requester-history", updatedAt: 1 });
    const client = identifiedClient(profile.id);
    client.connect.scopes = ["operator.admin"];
    const readChatStartupProjection = vi.fn<
      NonNullable<GatewayRequestContext["readChatStartupProjection"]>
    >(async () => undefined);
    const context = await createHistoryReadContext({ readChatStartupProjection });
    const measuredStatements: number[] = [];
    const measure = diagnostics.measureDiagnosticsTimelineSpan;
    vi.spyOn(diagnostics, "measureDiagnosticsTimelineSpan").mockImplementation(
      (name, run, options) => {
        if (!name.endsWith(".startup_projection")) {
          return measure(name, run, options);
        }
        // Count cached statements too; the old resolver reused PRAGMA data_version.
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
    const respond = vi.fn<RespondFn>();
    await expectDefined(
      chatHistoryHandlers["chat.history"],
      "history handler",
    )({
      params: scope,
      client,
      context,
      respond,
      req: { type: "req", id: "requester-history", method: "chat.history" },
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      true,
      expect.objectContaining({ sessionId: "requester-history" }),
    );
    expect(measuredStatements).toEqual([0]);
    expect(readChatStartupProjection).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ readPolicy: "ready" }),
    );
    expect(readChatStartupProjection.mock.calls[0]?.[0]).not.toHaveProperty(
      "readRequesterProfileId",
    );
  });
});
