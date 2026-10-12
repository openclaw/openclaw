// Dashboard title tests cover eligibility, routing, normalization, and guarded persistence.
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateConversationLabelWithFallback = vi.hoisted(() => vi.fn());
const resolveUtilityModelRefForAgent = vi.hoisted(() => vi.fn());
const readSessionTitleFieldsFromTranscript = vi.hoisted(() => vi.fn());
const updateSessionEntry = vi.hoisted(() => vi.fn());
const loadSessionEntry = vi.hoisted(() => vi.fn());

vi.mock("../agents/utility-model.js", () => ({ resolveUtilityModelRefForAgent }));
vi.mock("../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback,
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  patchSessionEntryCore: updateSessionEntry,
  loadSessionEntry,
}));
// mock-isolation: Title orchestration tests supply transcript reads without starting workers.
vi.mock("./session-transcript-title-reader.js", () => ({
  readSessionTitleFieldsFromTranscript,
  readSessionTitleFieldsFromTranscriptAsync: readSessionTitleFieldsFromTranscript,
}));

import type { WorktreeSourceStage } from "../agents/worktrees/types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { ChatAttachment } from "./chat-attachments.js";
import {
  buildDashboardSessionTitleSource,
  generateWorktreeSessionTitle,
  maybeGenerateDashboardSessionTitle,
  maybeGenerateSessionTitle,
  prepareDashboardSessionTitle,
} from "./dashboard-session-title.js";
import { deriveGoalSessionTitle } from "./derive-goal-session-title.js";

const cfg = {
  agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
} as OpenClawConfig;
const baseEntry: SessionEntry = {
  sessionId: "session-1",
  updatedAt: 1,
};

function titleParams(entry: SessionEntry | undefined = baseEntry) {
  loadSessionEntry.mockReturnValue(entry);
  return {
    cfg,
    agentId: "main",
    entry,
    sessionId: "session-1",
    sessionKey: "agent:main:dashboard:chat-1",
    storePath: "/tmp/openclaw/sessions.json",
    userMessage: "Help me plan the release",
  };
}

function mockSessionUpdate(current: SessionEntry): void {
  updateSessionEntry.mockImplementation(async (_scope, update) => {
    const patch = await update({ ...current });
    const result = patch ? { ...current, ...patch } : current;
    loadSessionEntry.mockReturnValue(result);
    return result;
  });
}

describe("maybeGenerateDashboardSessionTitle", () => {
  beforeEach(() => {
    generateConversationLabelWithFallback.mockReset();
    resolveUtilityModelRefForAgent.mockReset();
    updateSessionEntry.mockReset();
    loadSessionEntry.mockReset().mockReturnValue(baseEntry);
    readSessionTitleFieldsFromTranscript.mockReset();
    readSessionTitleFieldsFromTranscript.mockReturnValue({
      firstUserMessage: null,
      lastMessagePreview: null,
    });
    generateConversationLabelWithFallback.mockResolvedValue("Release Planning");
    resolveUtilityModelRefForAgent.mockReturnValue("openai/gpt-5.6-luna");
    mockSessionUpdate(baseEntry);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("routes both attempts through the effective session model and auth profile", async () => {
    const entry = {
      ...baseEntry,
      providerOverride: "anthropic",
      modelOverride: "claude-fable-5",
      authProfileOverride: "work",
    };
    resolveUtilityModelRefForAgent.mockReturnValue("anthropic/claude-haiku-4-5@work");
    mockSessionUpdate(entry);

    await expect(maybeGenerateDashboardSessionTitle(titleParams(entry))).resolves.toBe(true);

    expect(resolveUtilityModelRefForAgent).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      primaryProvider: "anthropic",
      primaryModelRef: "anthropic/claude-fable-5@work",
    });
    expect(generateConversationLabelWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        utilityModelRef: "anthropic/claude-haiku-4-5@work",
        regularModelRef: "anthropic/claude-fable-5@work",
        preferredProfile: "work",
      }),
    );
  });

  it("preserves a locked session harness as the title runtime owner", async () => {
    const entry = {
      ...baseEntry,
      agentHarnessId: "codex",
      agentRuntimeOverride: "openclaw",
      modelSelectionLocked: true,
    };
    mockSessionUpdate(entry);

    await expect(maybeGenerateDashboardSessionTitle(titleParams(entry))).resolves.toBe(true);

    expect(generateConversationLabelWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({ agentHarnessRuntimeOverride: "codex" }),
    );
  });

  it.each([false, true])(
    "preserves the native primary auth profile for utility models (ACP=%s)",
    async (acp) => {
      const profiledCfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5@personal" },
            utilityModel: "openai/gpt-5.6-luna",
          },
          entries: {
            main: acp ? { model: "harness-only@harness-profile", runtime: { type: "acp" } } : {},
          },
        },
      } as OpenClawConfig;
      resolveUtilityModelRefForAgent.mockReturnValue("openai/gpt-5.6-luna");

      await expect(
        maybeGenerateDashboardSessionTitle({ ...titleParams(), cfg: profiledCfg }),
      ).resolves.toBe(true);

      expect(generateConversationLabelWithFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          utilityModelRef: "openai/gpt-5.6-luna",
          regularModelRef: "openai/gpt-5.5@personal",
          preferredProfile: "personal",
        }),
      );
    },
  );

  it("goes directly to the regular model when utility routing is disabled", async () => {
    resolveUtilityModelRefForAgent.mockReturnValue(undefined);

    await expect(maybeGenerateDashboardSessionTitle(titleParams())).resolves.toBe(true);

    expect(generateConversationLabelWithFallback).toHaveBeenCalledWith(
      expect.not.objectContaining({ utilityModelRef: expect.anything() }),
    );
  });

  it.each([
    ['```text\n"Release Planning"\n```', "Release Planning"],
    ["Title:  Release   planning ", "Release planning"],
    ['Instruction to reply exactly "ok"', 'Instruction to reply exactly "ok"'],
    ['Instruction to reply exactly "ok', "Instruction to reply exactly ok"],
    ["Reply with 'ok'", "Reply with 'ok'"],
    ["Reply with ‘ok’", "Reply with ‘ok’"],
    ["Reply with ‘ok", "Reply with ok"],
    ["Reply with ok’", "Reply with ok"],
    ["Bestätige mit „ok“", "Bestätige mit „ok“"],
    ["Reply with “ok”", "Reply with “ok”"],
    ["Reply with «ok»", "Reply with «ok»"],
    ["„Release planning“", "Release planning"],
    ["“Release planning”", "Release planning"],
    ["«Release planning»", "Release planning"],
    ["Reply with „ok", "Reply with ok"],
    ["Reply with “ok", "Reply with ok"],
    ["Reply with «ok", "Reply with ok"],
    ["Reply with ok”", "Reply with ok"],
    ["Reply with ok»", "Reply with ok"],
    ["Don't change the user's title", "Don't change the user's title"],
    ["Don’t change the user’s title", "Don’t change the user’s title"],
    ["Users' permissions", "Users' permissions"],
    ["Users’ permissions", "Users’ permissions"],
    ['"Users\' permissions"', "Users' permissions"],
    ["“Users’ permissions”", "Users’ permissions"],
    ["Reply with 'users' permissions", "Reply with 'users' permissions"],
    ["Reply with ‘users’ permissions", "Reply with ‘users’ permissions"],
    ["Compare our permissions with other users’", "Compare our permissions with other users’"],
    ["Compare our permissions with other users'", "Compare our permissions with other users'"],
    ["'Users' permissions'", "Users' permissions"],
    ["‘Users’ permissions’", "Users’ permissions"],
    ["'Users' and admins' permissions'", "Users' and admins' permissions"],
    ["'Users' can't edit permissions'", "Users' can't edit permissions"],
    ["“Compare our permissions with other users’”", "Compare our permissions with other users’"],
    ["'users' or 'admins'", "'users' or 'admins'"],
    ["Compare users’/admins’ permissions", "Compare users’/admins’ permissions"],
    ["Review users'/permissions", "Review users'/permissions"],
    ["Compare users’, then admins’ permissions", "Compare users’, then admins’ permissions"],
    ["Reply with ‘users’, then ‘admins’", "Reply with ‘users’, then ‘admins’"],
    ["Reply with 'users', then 'admins'", "Reply with 'users', then 'admins'"],
    ["Compare users’+admins’ permissions", "Compare users’+admins’ permissions"],
    ["Reply with ‘users’+‘admins’", "Reply with ‘users’+‘admins’"],
    ["cafe\u0301’s setup", "cafe\u0301’s setup"],
    ["\"'Release notes'\"", "Release notes"],
    ["Reply with »ok«", "Reply with »ok«"],
    ['"ok" or "later"', '"ok" or "later"'],
    [`${"a".repeat(52)} "long quoted span"`, `${"a".repeat(52)} long q`],
    [`${"a".repeat(59)} 🚀`, "a".repeat(59)],
  ])("normalizes generated title wrappers", async (generated, expected) => {
    generateConversationLabelWithFallback.mockImplementation(async ({ normalizeLabel }) =>
      normalizeLabel(generated),
    );

    await expect(maybeGenerateDashboardSessionTitle(titleParams())).resolves.toBe(true);

    const update = updateSessionEntry.mock.calls[0]?.[1];
    expect(await update?.({ ...baseEntry })).toEqual({ displayName: expected });
  });

  it.each([
    ["legacy main session", { sessionKey: "agent:main:main" }],
    ["slash command", { userMessage: "/status" }],
    [
      "manual rename shaped like its Android device stamp",
      {
        sessionKey: "agent:main:node-1234567890ab",
        entry: { ...baseEntry, label: "OpenClaw App · Release planning · 1234567890ab" },
      },
    ],
    ["persisted display name", { entry: { ...baseEntry, displayName: "My release" } }],
  ])("skips %s", async (_name, override) => {
    const params = { ...titleParams(), ...override };
    loadSessionEntry.mockReturnValue(params.entry);
    await expect(maybeGenerateDashboardSessionTitle({ ...params, entry: baseEntry })).resolves.toBe(
      false,
    );

    expect(generateConversationLabelWithFallback).not.toHaveBeenCalled();
    expect(updateSessionEntry).not.toHaveBeenCalled();
  });

  it.each([
    ["ios new-session key", "agent:main:ios-7f3a9c2b1d0e"],
    ["android node key", "agent:main:node-1234567890ab"],
  ])("titles %s", async (_name, sessionKey) => {
    await expect(
      maybeGenerateDashboardSessionTitle({ ...titleParams(), sessionKey }),
    ).resolves.toBe(true);
    expect(generateConversationLabelWithFallback).toHaveBeenCalledOnce();
  });

  it("titles over an Android platform auto-label without treating it as a rename", async () => {
    const entry = {
      ...baseEntry,
      autoLabel: "OpenClaw App · Pixel · 1234567890ab",
    };
    mockSessionUpdate(entry);

    await expect(
      maybeGenerateDashboardSessionTitle({
        ...titleParams(entry),
        sessionKey: "agent:main:node-1234567890ab",
      }),
    ).resolves.toBe(true);

    const update = updateSessionEntry.mock.calls[0]?.[1];
    expect(await update?.({ ...entry })).toEqual({ displayName: "Release Planning" });
  });

  it("retries a historical session from the transcript's first user message", async () => {
    const entry = { ...baseEntry, systemSent: true };
    const transcript = createDeferredCore<{
      firstUserMessage: string;
      lastMessagePreview: string;
    }>();
    readSessionTitleFieldsFromTranscript.mockReturnValue(transcript.promise);
    mockSessionUpdate(entry);

    const naming = maybeGenerateDashboardSessionTitle({
      ...titleParams(entry),
      currentUserMessage: "Latest follow-up",
      userMessage: "Latest follow-up",
    });
    expect(generateConversationLabelWithFallback).not.toHaveBeenCalled();
    transcript.resolve({
      firstUserMessage: "[Mon 2026-08-10 12:00 UTC] Original release plan",
      lastMessagePreview: "Latest follow-up",
    });
    await expect(naming).resolves.toBe(true);

    expect(generateConversationLabelWithFallback.mock.calls[0]?.[0]?.userMessage).toBe(
      "Original release plan",
    );
  });

  it("preserves attachment-aware input when the first turn is already in the transcript", async () => {
    readSessionTitleFieldsFromTranscript.mockReturnValue({
      firstUserMessage: "[Mon 2026-08-10 12:00 UTC] Review this rollout",
      lastMessagePreview: "Review this rollout",
    });

    await expect(
      maybeGenerateDashboardSessionTitle({
        ...titleParams(),
        currentUserMessage: "Review this rollout",
        userMessage: "Review this rollout\nDeployment context",
      }),
    ).resolves.toBe(true);

    expect(generateConversationLabelWithFallback.mock.calls[0]?.[0]?.userMessage).toBe(
      "Review this rollout\nDeployment context",
    );
  });

  it("does not persist a deterministic title when utility-only speculation fails", async () => {
    generateConversationLabelWithFallback.mockRejectedValueOnce(new Error("route unavailable"));

    await expect(
      prepareDashboardSessionTitle({
        cfg,
        agentId: "main",
        userMessage: "Help me plan the release",
      }),
    ).resolves.toBeNull();
    expect(generateConversationLabelWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({ utilityOnly: true }),
    );
    expect(updateSessionEntry).not.toHaveBeenCalled();
  });

  it("evicts a settled naming request so a later rename attempt can run", async () => {
    generateConversationLabelWithFallback
      .mockRejectedValueOnce(new Error("route unavailable"))
      .mockResolvedValueOnce("Release Planning");

    await expect(maybeGenerateDashboardSessionTitle(titleParams())).resolves.toBe(true);
    // Clear the persisted name so a later send can claim naming again.
    loadSessionEntry.mockReturnValue(baseEntry);
    mockSessionUpdate(baseEntry);
    await expect(maybeGenerateDashboardSessionTitle(titleParams())).resolves.toBe(true);
    expect(generateConversationLabelWithFallback).toHaveBeenCalledTimes(2);
    const update = updateSessionEntry.mock.calls.at(-1)?.[1];
    expect(await update?.({ ...baseEntry })).toEqual({ displayName: "Release Planning" });
  });

  it.each(["unavailable", "renamed"])(
    "finishes a contended title safely when the session is %s",
    async (outcome) => {
      vi.useFakeTimers();
      const reply = createDeferredCore();
      const firstAttempt = createDeferredCore();
      const label = createDeferredCore<string>();
      const params = titleParams();
      const onFallback = vi.fn();
      generateConversationLabelWithFallback.mockImplementationOnce(async () => {
        firstAttempt.resolve();
        return await label.promise;
      });
      if (outcome === "unavailable") {
        generateConversationLabelWithFallback.mockRejectedValue(new Error("endpoint unavailable"));
      }
      const pending = maybeGenerateDashboardSessionTitle({
        ...params,
        retryAfter: reply.promise,
        onFallback,
      });
      await firstAttempt.promise;
      label.reject(new Error("conversation label generation failed (primary fallback)"));
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(updateSessionEntry).not.toHaveBeenCalled();
        expect(onFallback).not.toHaveBeenCalled();
        if (outcome === "renamed") {
          mockSessionUpdate({ ...baseEntry, label: "My custom name" });
        }
      } finally {
        reply.resolve();
        await pending;
      }
      await expect(pending).resolves.toBe(outcome !== "renamed");
      if (outcome === "unavailable") {
        expect(loadSessionEntry().displayName).toMatch(/^[a-z]+-[a-z]+$/);
        expect(onFallback).toHaveBeenCalledOnce();
      } else {
        expect(loadSessionEntry()).toMatchObject({ label: "My custom name" });
        expect(loadSessionEntry().displayName).toBeUndefined();
        expect(onFallback).not.toHaveBeenCalled();
      }
      expect(generateConversationLabelWithFallback).toHaveBeenCalledTimes(2);
    },
  );

  it("does not write into a reset session generation", async () => {
    mockSessionUpdate({ ...baseEntry, sessionId: "session-2" });

    await expect(maybeGenerateDashboardSessionTitle(titleParams())).resolves.toBe(false);

    expect(generateConversationLabelWithFallback).toHaveBeenCalledOnce();
  });

  it("bounds a worktree join without cancelling the canonical background naming request", async () => {
    vi.useFakeTimers();
    const naming = createDeferredCore<string>();
    generateConversationLabelWithFallback.mockReturnValue(naming.promise);
    const params = titleParams();
    const background = maybeGenerateDashboardSessionTitle(params);
    const onError = vi.fn();
    const onPersisted = vi.fn();
    const worktree = generateWorktreeSessionTitle({
      ...params,
      sessionKey: "dashboard:chat-1",
      onError,
      onPersisted,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(worktree).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    naming.resolve("Release Planning");
    await expect(background).resolves.toBe(true);
    expect(generateConversationLabelWithFallback).toHaveBeenCalledOnce();
    expect(onPersisted).not.toHaveBeenCalled();
    expect(loadSessionEntry()).toMatchObject({ displayName: "Release Planning" });
  });

  it.each(["generated", "fallback"])(
    "persists a late %s title after the worktree caller stops waiting",
    async (outcome) => {
      vi.useFakeTimers();
      const naming = createDeferredCore<string>();
      generateConversationLabelWithFallback.mockReturnValue(naming.promise);
      const params = titleParams();
      const onError = vi.fn();
      const onPersisted = vi.fn();
      const worktree = generateWorktreeSessionTitle({ ...params, onError, onPersisted });
      const background = maybeGenerateDashboardSessionTitle(params);

      await vi.advanceTimersByTimeAsync(8_000);
      expect(onError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(22_000);
      await expect(worktree).resolves.toBeUndefined();
      expect(onError).toHaveBeenCalledOnce();
      expect(updateSessionEntry).not.toHaveBeenCalled();
      if (outcome === "generated") {
        naming.resolve("Release Planning");
      } else {
        naming.reject(new Error("model attempts exhausted"));
      }
      await background;
      await vi.advanceTimersByTimeAsync(0);

      expect(loadSessionEntry()).toMatchObject({
        displayName:
          outcome === "generated" ? "Release Planning" : expect.stringMatching(/^[a-z]+-[a-z]+$/),
      });
      expect(onPersisted).toHaveBeenCalledOnce();
      expect(updateSessionEntry).toHaveBeenCalledOnce();
      expect(generateConversationLabelWithFallback).toHaveBeenCalledOnce();
    },
  );

  it.each([1, 2])(
    "retries a joined title failure only once (%s failed writes)",
    async (failures) => {
      const naming = createDeferredCore<string>();
      generateConversationLabelWithFallback.mockReturnValueOnce(naming.promise);
      const params = titleParams();
      for (let attempt = 0; attempt < failures; attempt++) {
        updateSessionEntry.mockRejectedValueOnce(new Error("temporary write failure"));
      }
      const onPersisted = vi.fn();
      const worktree = generateWorktreeSessionTitle({ ...params, onError: vi.fn(), onPersisted });
      const background = maybeGenerateDashboardSessionTitle(params);
      const expected =
        failures === 1
          ? expect(background).resolves.toBe(true)
          : expect(background).rejects.toThrow("temporary write failure");
      naming.resolve("Release Planning");
      await Promise.all([worktree, expected]);

      expect(generateConversationLabelWithFallback).toHaveBeenCalledTimes(2);
      expect(updateSessionEntry).toHaveBeenCalledTimes(2);
      expect(onPersisted).not.toHaveBeenCalled();
      expect(loadSessionEntry().displayName).toBe(failures === 1 ? "Release Planning" : undefined);
    },
  );

  it("revalidates worktree authority inside the final title commit", async () => {
    const writePrepared = createDeferredCore();
    const releaseWrite = createDeferredCore();
    let active = true;
    const commitGuard = () => {
      if (!active) {
        throw new Error("run closed");
      }
    };
    updateSessionEntry.mockImplementation(async (_scope, update, options) => {
      const patch = await update({ ...baseEntry });
      writePrepared.resolve();
      await releaseWrite.promise;
      options.workerGuard?.source?.();
      loadSessionEntry.mockReturnValue({ ...baseEntry, ...patch });
      return loadSessionEntry();
    });
    const onPersisted = vi.fn();
    const worktree = generateWorktreeSessionTitle({
      ...titleParams(),
      commitGuard,
      onError: vi.fn(),
      onPersisted,
    });
    const rejected = expect(worktree).rejects.toThrow("run closed");
    await writePrepared.promise;
    active = false;
    releaseWrite.resolve();
    await rejected;
    expect(loadSessionEntry()).not.toHaveProperty("displayName");
    expect(onPersisted).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent title requests for one session generation", async () => {
    let resolveLabel!: (value: string) => void;
    generateConversationLabelWithFallback.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveLabel = resolve;
      }),
    );

    const first = maybeGenerateDashboardSessionTitle(titleParams());
    const duplicate = maybeGenerateDashboardSessionTitle(titleParams());
    resolveLabel("Release Planning");
    await expect(first).resolves.toBe(true);
    await expect(duplicate).resolves.toBe(false);

    expect(generateConversationLabelWithFallback).toHaveBeenCalledOnce();
    expect(updateSessionEntry).toHaveBeenCalledOnce();
    expect(loadSessionEntry).toHaveBeenCalledOnce();
    expect(readSessionTitleFieldsFromTranscript).toHaveBeenCalledOnce();
  });
});

describe("buildDashboardSessionTitleSource", () => {
  it("combines an ordinary command with large pasted text within the title-source cap", async () => {
    const pastedText = `Release details ${"x".repeat(2_000)}`;
    const source = buildDashboardSessionTitleSource({
      message: "Review this rollout [[reply_to_current]]",
      attachments: [textAttachment("Deployment context"), textAttachment(pastedText)],
    });
    expect(source).toBe(
      `Review this rollout [[reply_to_current]]\nDeployment context\n${pastedText}`.slice(0, 1_000),
    );
  });

  it.each([
    ["attachment-only", "", "Pasted migration checklist"],
    ["slash command with attachment", "/status", "Pasted incident report"],
  ])("titles an %s turn from its text attachment", async (_name, userMessage, text) => {
    expect(
      buildDashboardSessionTitleSource({
        message: userMessage,
        attachments: [textAttachment(text)],
      }),
    ).toBe(text);
  });

  it.each([
    ["malformed base64", { mimeType: "text/plain", content: "%%%" }],
    [
      "invalid UTF-8",
      { mimeType: "text/plain", content: Buffer.from([0xc3, 0x28]).toString("base64") },
    ],
    ["non-text", { mimeType: "image/png", content: Buffer.from("not text").toString("base64") }],
  ] satisfies Array<[string, ChatAttachment]>)(
    "ignores %s attachments",
    async (_name, attachment) =>
      expect(buildDashboardSessionTitleSource({ message: "", attachments: [attachment] })).toBe(""),
  );

  it("ignores a long text attachment with malformed trailing base64", async () => {
    const valid = Buffer.from("a".repeat(4_000)).toString("base64");
    const malformed = `${valid.slice(0, -4)}AAA%`;

    expect(
      buildDashboardSessionTitleSource({
        message: "",
        attachments: [{ mimeType: "text/plain", content: malformed }],
      }),
    ).toBe("");
  });

  it("keeps attachment-derived title input on a UTF-16 boundary", async () => {
    expect(
      buildDashboardSessionTitleSource({
        message: "",
        attachments: [textAttachment(`${"a".repeat(999)}🚀tail`)],
      }),
    ).toBe("a".repeat(999));
  });
});

function textAttachment(text: string): ChatAttachment {
  return {
    type: "file",
    mimeType: "text/plain",
    content: Buffer.from(text).toString("base64"),
  };
}

describe("deriveGoalSessionTitle", () => {
  it("returns undefined for empty or whitespace input", () => {
    expect(deriveGoalSessionTitle(undefined)).toBeUndefined();
    expect(deriveGoalSessionTitle("")).toBeUndefined();
    expect(deriveGoalSessionTitle("   ")).toBeUndefined();
  });

  it("skips slash commands", () => {
    expect(deriveGoalSessionTitle("/new")).toBeUndefined();
    expect(deriveGoalSessionTitle("/model openai/gpt-5.4")).toBeUndefined();
  });

  it("prefers a task-verb sentence over earlier banter", () => {
    expect(deriveGoalSessionTitle("Hey. Investigate why heartbeat failed overnight.")).toBe(
      "Investigate why heartbeat failed overnight.",
    );
  });

  it("strips inbound metadata before deriving", () => {
    expect(
      deriveGoalSessionTitle(
        "[Mon 2026-08-10 12:00 UTC] investigate why heartbeat failed overnight",
      ),
    ).toBe("Investigate why heartbeat failed overnight");
  });

  it("ignores host envelope leftovers that are not a user task", () => {
    expect(
      deriveGoalSessionTitle("<environment_context>\n{}\n</environment_context>"),
    ).toBeUndefined();
    expect(
      deriveGoalSessionTitle("<recommended_plugins>\nHere is a list of plugins\n"),
    ).toBeUndefined();
  });

  it("truncates long goals at a word boundary within 60 characters", () => {
    const result = deriveGoalSessionTitle(
      "investigate the long gateway timeout that keeps happening when the utility model cannot name sessions during onboarding",
    );
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(60);
    expect(result!.endsWith("…")).toBe(true);
  });
});

describe("worktree title source lifecycle", () => {
  const mocks = {
    generate: generateConversationLabelWithFallback,
    utility: resolveUtilityModelRefForAgent,
    readTranscript: readSessionTitleFieldsFromTranscript,
    load: loadSessionEntry,
    patch: updateSessionEntry,
  };
  const sourceEntry: SessionEntry = { sessionId: "source-title-session", updatedAt: 1 };
  let current: SessionEntry;

  function sourceTitleParams(name: string) {
    return {
      cfg,
      agentId: "main",
      entry: sourceEntry,
      sessionId: sourceEntry.sessionId,
      sessionKey: `agent:main:dashboard:source-${name}`,
      storePath: "/synthetic/title-sessions.sqlite",
      userMessage: "Help me plan the release",
    };
  }

  function sourceStages(
    context: AsyncLocalStorage<string>,
    unwindFailure?: { after: Promise<void>; error: Error },
  ) {
    const entered: string[] = [];
    const closed: string[] = [];
    const asserted: string[] = [];
    const active = new Set<string>();
    const withSource: WorktreeSourceStage = async (run) => {
      const stage = `source:${entered.length + 1}`;
      entered.push(stage);
      active.add(stage);
      return await context.run(stage, async () => {
        try {
          const result = await run({
            assertCurrent: () => {
              if (!active.has(stage) || context.getStore() !== stage) {
                throw new Error("source stage is no longer current");
              }
              asserted.push(stage);
            },
          });
          if (unwindFailure) {
            await unwindFailure.after;
            throw unwindFailure.error;
          }
          return result;
        } finally {
          active.delete(stage);
          closed.push(stage);
        }
      });
    };
    return { withSource, entered, closed, asserted, active };
  }

  beforeEach(() => {
    current = { ...sourceEntry };
    mocks.generate.mockReset();
    mocks.utility.mockReset().mockReturnValue(undefined);
    mocks.readTranscript.mockReset().mockReturnValue({
      firstUserMessage: null,
      lastMessagePreview: null,
    });
    mocks.load.mockReset().mockImplementation(() => ({ ...current }));
    mocks.patch.mockReset().mockImplementation(async (_scope, update, options) => {
      const patch = await update({ ...current });
      options.workerGuard?.source?.();
      if (patch) {
        current = { ...current, ...patch };
      }
      return { ...current };
    });
  });

  it.each([false, true])(
    "uses fresh source authority for persistence (late completion: %s)",
    async (late) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const context = new AsyncLocalStorage<string>();
      const owner = new AsyncWorkScope();
      const source = sourceStages(context);
      const started = createDeferredCore();
      const continueGeneration = createDeferredCore();
      const persisted = createDeferredCore();
      const generationContexts: Array<string | undefined> = [];
      let continuationAborted: boolean | undefined;
      let writeContext: string | undefined;
      let acceptanceContext: string | undefined;
      let writeAssertions: string[] = [];
      mocks.generate.mockImplementation(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
        generationContexts.push(context.getStore());
        started.resolve();
        await continueGeneration.promise;
        generationContexts.push(context.getStore());
        continuationAborted = abortSignal?.aborted;
        return "Scoped release planning";
      });
      mocks.load.mockImplementation(() => {
        if (current.displayName) {
          acceptanceContext = context.getStore();
        }
        return { ...current };
      });
      mocks.patch.mockImplementation(async (_scope, update, options) => {
        const patch = await update({ ...current });
        await Promise.resolve();
        writeContext = context.getStore();
        const before = source.asserted.length;
        options.workerGuard?.source?.();
        writeAssertions = source.asserted.slice(before);
        current = { ...current, ...patch };
        return { ...current };
      });
      const onError = vi.fn();
      const onPersisted = vi.fn(() => persisted.resolve());
      const request = context.run("caller", () =>
        owner.run(() =>
          generateWorktreeSessionTitle({
            ...sourceTitleParams("success"),
            withSource: source.withSource,
            onError,
            onPersisted,
          }),
        ),
      );
      const settled = request.then(
        () => undefined,
        () => undefined,
      );
      try {
        await Promise.race([
          started.promise,
          request.then(() => {
            throw new Error("title completed before generation started");
          }),
        ]);
        await nextTurn();
        expect(source.entered.length).toBeGreaterThan(0);
        expect(source.closed).toEqual(source.entered);
        expect(source.active.size).toBe(0);
        expect(mocks.patch).not.toHaveBeenCalled();
        if (late) {
          await vi.advanceTimersByTimeAsync(30_000);
          await expect(request).resolves.toBeUndefined();
          expect(onError).toHaveBeenCalledOnce();
        }
        continueGeneration.resolve();
        await persisted.promise;
        if (!late) {
          await expect(request).resolves.toBe("Scoped release planning");
          expect(source.entered).toContain(acceptanceContext);
          expect(acceptanceContext).not.toBe(writeContext);
          expect(acceptanceContext).not.toBe(source.entered[0]);
          expect(onError).not.toHaveBeenCalled();
        }
        expect(generationContexts).toEqual(["caller", "caller"]);
        expect(continuationAborted).toBe(false);
        expect(source.entered).toContain(writeContext);
        expect(writeContext).not.toBe(source.entered[0]);
        expect(writeAssertions).toEqual([writeContext]);
        expect(source.closed).toEqual(source.entered);
        expect(onPersisted).toHaveBeenCalledOnce();
        expect(current.displayName).toBe("Scoped release planning");
      } finally {
        continueGeneration.resolve();
        await settled;
        await owner.drain();
        context.disable();
        vi.useRealTimers();
      }
    },
  );

  it("keeps duplicate cancellation separate from the original title owner", async () => {
    const context = new AsyncLocalStorage<string>();
    const owner = new AsyncWorkScope();
    const duplicateOwner = new AsyncWorkScope();
    const source = sourceStages(context);
    const started = createDeferredCore();
    const generation = createDeferredCore<string>();
    let signal: AbortSignal | undefined;
    let cancellationContext: string | undefined;
    let duplicateSources = 0;
    const duplicateSource: WorktreeSourceStage = async () => {
      duplicateSources += 1;
      throw new Error("duplicate must not acquire title generation custody");
    };
    mocks.generate.mockImplementation(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      signal = abortSignal;
      if (abortSignal) {
        abortSignal.addEventListener(
          "abort",
          () => {
            cancellationContext = context.getStore();
            generation.reject(abortSignal.reason);
          },
          { once: true },
        );
      }
      started.resolve();
      return await generation.promise;
    });
    const params = sourceTitleParams("duplicate");
    const first = context.run("owner", () =>
      owner.run(() => maybeGenerateSessionTitle({ ...params, withSource: source.withSource })),
    );
    const settled = first.then(
      () => undefined,
      () => undefined,
    );
    try {
      await Promise.race([
        started.promise,
        first.then(() => {
          throw new Error("title completed before generation started");
        }),
      ]);
      const duplicate = context.run("duplicate", () =>
        duplicateOwner.run(() =>
          maybeGenerateSessionTitle({ ...params, withSource: duplicateSource }),
        ),
      );
      context.run("duplicate", () => duplicateOwner.beginClose(new Error("duplicate closed")));
      await duplicateOwner.drain();
      expect(signal?.aborted).toBe(false);
      expect(duplicateSources).toBe(0);

      const originalClosed = new Error("original title owner closed");
      const duplicateRejected = expect(duplicate).rejects.toBe(originalClosed);
      context.run("unrelated", () => owner.beginClose(originalClosed));
      await expect(first).rejects.toBe(originalClosed);
      await duplicateRejected;
      expect(signal?.reason).toBe(originalClosed);
      expect(cancellationContext).toBe("owner");
      expect(mocks.generate).toHaveBeenCalledOnce();
      expect(mocks.patch).not.toHaveBeenCalled();
      expect(source.closed).toEqual(source.entered);
    } finally {
      generation.resolve("Fixture cleanup");
      await settled;
      await Promise.all([owner.drain(), duplicateOwner.drain()]);
      context.disable();
    }
  });

  it.each(["source unwind", "parent close"] as const)(
    "joins owned resource cleanup before rejecting %s",
    async (cause) => {
      const context = new AsyncLocalStorage<string>();
      const owner = new AsyncWorkScope();
      const failure = new Error(
        cause === "source unwind" ? "source scope unwind failed" : "title owner closed",
      );
      const started = createDeferredCore();
      const generation = createDeferredCore<string>();
      const source = sourceStages(
        context,
        cause === "source unwind" ? { after: started.promise, error: failure } : undefined,
      );
      const cleanupStarted = createDeferredCore();
      const finishCleanup = createDeferredCore();
      const events: string[] = [];
      let signal: AbortSignal | undefined;
      let cancellationContext: string | undefined;
      let cleanupContext: string | undefined;
      let requestSettled = false;
      mocks.generate.mockImplementation(({ abortSignal }: { abortSignal?: AbortSignal }) => {
        signal = abortSignal;
        abortSignal?.addEventListener(
          "abort",
          () => {
            cancellationContext = context.getStore();
            events.push("cancelled");
            if (cause === "parent close") {
              generation.reject(abortSignal.reason);
            }
          },
          { once: true },
        );
        return runWithAsyncWorkResources(async (onAcquired) => {
          onAcquired({
            release: async () => {
              cleanupContext = context.getStore();
              events.push("cleanup-started");
              cleanupStarted.resolve();
              await finishCleanup.promise;
              events.push("cleanup-finished");
            },
          });
          started.resolve();
          if (cause === "parent close") {
            return await generation.promise;
          }
          events.push("logical-result");
          return "Unpublished title";
        });
      });
      const request = context.run("caller", () =>
        owner.run(() =>
          maybeGenerateSessionTitle({ ...sourceTitleParams(cause), withSource: source.withSource }),
        ),
      );
      const outcome = request.then(
        (value) => {
          requestSettled = true;
          events.push("resolved");
          return { value };
        },
        (error: unknown) => {
          requestSettled = true;
          events.push("rejected");
          return { error };
        },
      );
      try {
        if (cause === "parent close") {
          await started.promise;
          await nextTurn();
          expect(source.closed).toEqual(source.entered);
          context.run("unrelated", () => owner.beginClose(failure));
        }
        await Promise.race([
          cleanupStarted.promise,
          outcome.then(() => {
            throw new Error("title settled before cleanup started");
          }),
        ]);
        await nextTurn();
        if (cause === "source unwind") {
          expect(source.closed).toEqual(["source:1"]);
          expect(events).toContain("logical-result");
        }
        expect(signal?.aborted).toBe(true);
        expect(signal?.reason).toBe(failure);
        expect(cancellationContext).toBe("caller");
        expect(cleanupContext).toBe("caller");
        expect(requestSettled).toBe(false);
        expect(mocks.patch).not.toHaveBeenCalled();
        finishCleanup.resolve();
        await expect(outcome).resolves.toEqual({ error: failure });
        expect(events).toContain("cleanup-finished");
        expect(events.indexOf("cleanup-finished")).toBeLessThan(events.indexOf("rejected"));
        expect(current).toEqual(sourceEntry);
      } finally {
        context.run("caller", () => owner.beginClose(new Error("Fixture cleanup")));
        started.resolve();
        generation.resolve("Fixture cleanup");
        finishCleanup.resolve();
        try {
          await outcome;
          await owner.drain();
        } finally {
          context.disable();
        }
      }
    },
  );
});
