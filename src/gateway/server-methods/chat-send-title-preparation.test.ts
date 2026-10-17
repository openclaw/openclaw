import { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { sessionTitleRequests } from "../session-title-state.js";
import { scheduleChatDashboardSessionTitle } from "./chat-send-background.js";
import { sessionCompactHandlers } from "./sessions-compact.js";

const generate = vi.hoisted(() =>
  vi.fn<
    typeof import("../../auto-reply/reply/conversation-label-generator.js").generateConversationLabelWithFallback
  >(),
);
vi.mock("../../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback: generate,
}));

type TitleOptions = {
  cfg?: OpenClawConfig;
  writeConfig?: boolean;
  legacyPath?: boolean;
  titleSource?: string;
};
async function createTitleFixture(state: OpenClawTestState, options: TitleOptions) {
  const cfg = options.cfg ?? { agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } } };
  if (options.writeConfig) {
    await state.writeConfig(cfg);
  }
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:dashboard:title-test",
    sessionId: "title-test",
    storePath: options.legacyPath
      ? resolveSessionStorePathCore(undefined, { agentId: "main" })
      : resolveOpenClawAgentSqlitePath({ agentId: "main" }),
  };
  await replaceSessionEntry(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    ...(options.titleSource ? { pendingWorktree: { titleSource: options.titleSource } } : {}),
  });
  const started = createDeferredCore();
  const generation = createDeferredCore<string>();
  generate.mockReset().mockImplementation(async () => {
    started.resolve();
    return await generation.promise;
  });
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  let title: Promise<boolean> | undefined;
  return {
    scope,
    context,
    append: async (...contents: string[]) => {
      for (const content of contents) {
        await appendTranscriptMessage(scope, {
          cwd: state.workspaceDir,
          message: { role: "user", content, timestamp: 1 },
        });
      }
    },
    start: async (rawMessage: string, released?: Promise<void>, failOnWarn = false) => {
      const failed = createDeferredCore<never>();
      if (failOnWarn) {
        context.logGateway.warn = (message) => failed.reject(new Error(message));
      }
      scheduleChatDashboardSessionTitle(
        {
          ...scope,
          admittedSessionId: scope.sessionId,
          cfg,
          context,
          request: { rawMessage, normalizedAttachments: [] },
        },
        released,
      );
      await Promise.race([started.promise, failed.promise]);
      title = sessionTitleRequests.get(scope);
      expect(title).toBeDefined();
    },
    finish: async (label = "Original release plan", ignoreFailure = false) => {
      if (ignoreFailure) {
        title = title?.catch(() => false);
      }
      generation.resolve(label);
      await title;
    },
  };
}
async function withTitle(
  options: TitleOptions,
  run: (fixture: Awaited<ReturnType<typeof createTitleFixture>>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const fixture = await createTitleFixture(state, options);
    try {
      await run(fixture);
    } finally {
      await fixture.finish();
    }
  });
}

it.each(["persisted", "failed"])("publishes pending and %s title settlement", async (outcome) => {
  await withTitle({ legacyPath: true }, async ({ scope, context, start, finish }) => {
    const states: boolean[] = [];
    const stop = sessionChanges.subscribe((change) => {
      if (
        "sessionKey" in change &&
        change.sessionKey === scope.sessionKey &&
        change.scope === "runtime"
      ) {
        states.push(sessionTitleRequests.get(scope) !== undefined);
      }
    });
    const warned = createDeferredCore();
    context.logGateway.warn = () => warned.resolve();
    const write =
      outcome === "failed"
        ? vi
            .spyOn(sessionAccessor, "patchSessionEntryCore")
            .mockRejectedValueOnce(new Error("title write failed"))
        : undefined;
    try {
      await start("Plan the release");
      expect(states).toEqual([true]);
      await finish("Release planning", true);
      if (outcome === "failed") {
        await warned.promise;
      }
      expect(states).toEqual([true, false]);
      expect(sessionTitleRequests.get(scope)).toBeUndefined();
      expect(loadSessionEntry(scope)?.displayName).toBe(
        outcome === "persisted" ? "Release planning" : undefined,
      );
    } finally {
      write?.mockRestore();
      stop();
    }
  });
});

it.each([
  { titleSource: undefined, expectedSource: "Original release plan" },
  { titleSource: "Accepted worktree intent", expectedSource: "Accepted worktree intent" },
])(
  "prepares one detached title entry from $expectedSource",
  async ({ titleSource, expectedSource }) => {
    await withTitle(
      { writeConfig: true, titleSource },
      async ({ scope, append, start, finish }) => {
        await append("Original release plan");
        const reads = observeSqliteReadSql(StatementSync.prototype);
        try {
          await start("A later follow-up", undefined, true);
          expect(
            reads.queries.filter((sql) => /\b(?:from|join)\s+"?session_nodes\b/u.test(sql)).length,
          ).toBeLessThanOrEqual(1);
          expect(generate).toHaveBeenCalledOnce();
          expect(generate.mock.calls[0]?.[0].userMessage).toBe(expectedSource);
        } finally {
          reads.restore();
          await finish();
        }
        expect(loadSessionEntry(scope)?.displayName).toBe("Original release plan");
      },
    );
  },
);

it("compacts after the reply releases its admission while its title is still generating", async () => {
  await withTitle(
    { cfg: { agents: { entries: { main: {} } } }, writeConfig: true, legacyPath: true },
    async ({ scope, context, append, start, finish }) => {
      await append("First question", "Follow-up question", "Final answer");
      const admission = await beginSessionWorkAdmission({
        scope: scope.storePath,
        identities: [scope.sessionKey, scope.sessionId],
        assertAllowed: () => {},
      });
      const compact = async () => {
        const respond = vi.fn();
        await sessionCompactHandlers["sessions.compact"]!({
          req: { type: "req", id: "compact", method: "sessions.compact" },
          params: { key: scope.sessionKey, maxLines: 2 },
          client: null,
          isWebchatConnect: () => false,
          respond,
          context,
        });
        return respond;
      };
      try {
        await start("First question", admission.released);
        expect(await compact()).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ message: expect.stringContaining("has an active run") }),
        );
        admission.release();
        expect(await compact()).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ compacted: true }),
          undefined,
        );
      } finally {
        admission.release();
        await finish("First question");
      }
      expect(loadSessionEntry(scope)?.displayName).toBe("First question");
    },
  );
});
