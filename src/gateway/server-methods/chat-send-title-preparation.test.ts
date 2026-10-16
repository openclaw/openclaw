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
import {
  beginSessionWorkAdmission,
  getSessionWorkAdmissionRelease,
  interruptSessionWorkAdmissions,
} from "../../sessions/session-lifecycle-admission.js";
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

async function createTitleFixture(
  name: string,
  options: {
    state?: OpenClawTestState;
    cfg?: OpenClawConfig;
    titleSource?: string;
    storePath?: string;
  } = {},
) {
  const cfg = options.cfg ?? { agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } } };
  await options.state?.writeConfig(cfg);
  const scope = {
    agentId: "main",
    sessionKey: `agent:main:dashboard:${name}`,
    sessionId: `${name}-session`,
    storePath: options.storePath ?? resolveOpenClawAgentSqlitePath({ agentId: "main" }),
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
  const schedule = (rawMessage: string, released?: Promise<void>) =>
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
  return { cfg, scope, started, generation, context, schedule };
}

it.each(["persisted", "failed"])("publishes pending and %s title settlement", async (outcome) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const {
      scope,
      started,
      generation: naming,
      context,
      schedule,
    } = await createTitleFixture("title-notification", {
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    });
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
      schedule("Plan the release");
      await started.promise;
      const request = sessionTitleRequests.get(scope)!;
      const settled = request.catch(() => false);
      expect(states).toEqual([true]);
      naming.resolve("Release planning");
      await settled;
      if (outcome === "failed") {
        await warned.promise;
      }
      expect(states).toEqual([true, false]);
      expect(sessionTitleRequests.get(scope)).toBeUndefined();
      expect(loadSessionEntry(scope)?.displayName).toBe(
        outcome === "persisted" ? "Release planning" : undefined,
      );
    } finally {
      naming.resolve("Release planning");
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
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { scope, started, generation, context, schedule } = await createTitleFixture(
        "detached-title",
        { state, titleSource },
      );
      await appendTranscriptMessage(scope, {
        cwd: state.workspaceDir,
        message: { role: "user", content: "Original release plan", timestamp: 1 },
      });
      const failed = createDeferredCore<never>();
      context.logGateway.warn = (message) => failed.reject(new Error(message));
      const reads = observeSqliteReadSql(StatementSync.prototype);
      let title: Promise<boolean> | undefined;
      try {
        schedule("A later follow-up");
        await Promise.race([started.promise, failed.promise]);
        title = sessionTitleRequests.get(scope);
        expect(title).toBeDefined();
        expect(
          reads.queries.filter((sql) => /\b(?:from|join)\s+"?session_nodes\b/u.test(sql)).length,
        ).toBeLessThanOrEqual(1);
        expect(generate).toHaveBeenCalledOnce();
        expect(generate.mock.calls[0]?.[0].userMessage).toBe(expectedSource);
      } finally {
        reads.restore();
        generation.resolve("Original release plan");
        await title;
      }
      expect(loadSessionEntry(scope)?.displayName).toBe("Original release plan");
    });
  },
);

it("falls back after one label attempt without an overlapping turn", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const {
      scope,
      started,
      generation: label,
      schedule,
    } = await createTitleFixture("settled-title");
    schedule("Plan the release");
    await started.promise;
    const title = sessionTitleRequests.get(scope);
    expect(title).toBeDefined();
    label.reject(new Error("conversation label generation failed (primary fallback)"));
    await title;
    expect(generate).toHaveBeenCalledOnce();
    expect(loadSessionEntry(scope)?.displayName).toMatch(/^[a-z]+-[a-z]+$/);
  });
});

it("compacts after the reply releases its admission while its title is still generating", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const {
      scope,
      started: titleStarted,
      generation,
      context,
      schedule,
    } = await createTitleFixture("compact-after-reply", {
      state,
      cfg: { agents: { entries: { main: {} } } },
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    });
    for (const content of ["First question", "Follow-up question", "Final answer"]) {
      await appendTranscriptMessage(scope, {
        cwd: state.workspaceDir,
        message: { role: "user", content, timestamp: 1 },
      });
    }
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
    let title: Promise<boolean> | undefined;
    try {
      schedule("First question", admission.released);
      await titleStarted.promise;
      title = sessionTitleRequests.get(scope);
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
      generation.resolve("First question");
      await title;
    }
    expect(loadSessionEntry(scope)?.displayName).toBe("First question");
  });
});

it("does not hold session admission while a dashboard title is generating", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { scope, started, generation, context, schedule } = await createTitleFixture(
      "rollover-title-gate",
      { state },
    );
    await appendTranscriptMessage(scope, {
      cwd: state.workspaceDir,
      message: { role: "user", content: "Original release plan", timestamp: 1 },
    });
    const failed = createDeferredCore<never>();
    context.logGateway.warn = (message) => failed.reject(new Error(message));
    const admissionQuery = {
      scope: scope.storePath,
      identities: [scope.sessionKey, scope.sessionId],
    };
    let title: Promise<boolean> | undefined;
    let competing: { release: () => void } | undefined;
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      schedule("A later follow-up", Promise.resolve());
      await Promise.race([started.promise, failed.promise]);
      title = sessionTitleRequests.get(scope);
      expect(title).toBeDefined();
      expect(generate).toHaveBeenCalledOnce();
      expect(getSessionWorkAdmissionRelease(admissionQuery)).toBeUndefined();
      const titleDrain = interruptSessionWorkAdmissions({ ...admissionQuery, timeoutMs: 0 });
      await vi.advanceTimersByTimeAsync(0);
      await expect(titleDrain).resolves.toBe(true);

      competing = await beginSessionWorkAdmission({
        scope: scope.storePath,
        identities: ["agent:main:dashboard:competing-title-lease"],
        assertAllowed: () => {},
      });
      const competingDrain = interruptSessionWorkAdmissions({
        scope: scope.storePath,
        identities: ["agent:main:dashboard:competing-title-lease"],
        timeoutMs: 0,
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(competingDrain).resolves.toBe(false);
    } finally {
      competing?.release();
      generation.resolve("Original release plan");
      await title;
      vi.useRealTimers();
    }
    expect(loadSessionEntry(scope)?.displayName).toBe("Original release plan");
  });
});
