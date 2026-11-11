import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { withFastReplyConfig } from "./reply/get-reply-fast-path.test-support.js";
import { loadGetReplyModuleForTest } from "./reply/get-reply.test-loader.js";
import { createModelSelectionStateFixture } from "./reply/model-selection.test-support.js";
import { createMockTypingController } from "./reply/reply.test-helpers.js";
import type { MsgContext } from "./templating.js";

const runPreparedReply = vi.hoisted(() => vi.fn());

vi.mock("../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-scope.js")>()),
  resolveSessionAgentId: vi.fn(() => "main"),
  resolveAgentSkillsFilter: vi.fn(() => undefined),
}));
vi.mock("../agents/model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/model-selection.js")>()),
  resolveModelRefFromString: vi.fn(() => null),
}));
// mock-isolation: Streaming timeout cases use a fixed deadline independent of operator configuration.
vi.mock("../agents/timeout.js", () => ({ resolveAgentTimeoutMs: vi.fn(() => 60_000) }));
vi.mock("../channels/model-overrides.js", () => ({
  resolveChannelModelOverride: vi.fn(() => undefined),
}));
// mock-isolation: Each streaming case supplies its own config without loading operator state.
vi.mock("../config/config.js", () => ({ getRuntimeConfig: vi.fn(() => ({})) }));
vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
// mock-isolation: Streaming fixtures authorize their sender without command-owner database admission.
vi.mock("./command-auth.js", () => ({
  resolveCommandAuthorizationAsync: vi.fn(() => ({ isAuthorizedSender: true })),
}));
vi.mock("./reply/directive-handling.defaults.js", () => ({
  resolveDefaultModel: vi.fn(() => ({
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: { byAlias: new Map(), byKey: new Map() },
  })),
}));
vi.mock("./reply/model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply/model-selection.js")>()),
  createModelSelectionState: vi.fn<
    typeof import("./reply/model-selection.js").createModelSelectionState
  >(async (params) => createModelSelectionStateFixture(params)),
}));
vi.mock("./reply/session-reset-model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply/session-reset-model.js")>()),
  applyResetModelOverride: vi.fn(async () => undefined),
}));
vi.mock("./reply/stage-sandbox-media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply/stage-sandbox-media.js")>()),
  stageSandboxMedia: vi.fn(async () => undefined),
}));
// mock-isolation: The fixture controls typing lifecycle without starting background typing timers.
vi.mock("./reply/typing.js", () => ({ createTypingController: createMockTypingController }));

// mock-isolation: Scripted provider results isolate block ordering and fallback from live model calls.
vi.mock("./reply/get-reply-run.js", () => ({ runPreparedReply }));

const message: MsgContext = {
  Body: "ping",
  From: "+1004",
  To: "+2000",
  Provider: "telegram",
  Surface: "telegram",
  ChatType: "direct",
};

function createReplyConfig(state: OpenClawTestState, streamMode?: "block"): OpenClawConfig {
  const defaults = {
    model: { primary: "anthropic/claude-opus-4-6" },
    workspace: state.workspaceDir,
  };
  const telegram = { allowFrom: ["*"], ...(streamMode && { streaming: { mode: streamMode } }) };
  return withFastReplyConfig({
    agents: { defaults },
    channels: { telegram },
    session: { store: path.join(state.sessionsDir("main"), "sessions.json") },
  } satisfies OpenClawConfig);
}

it("handles ordering, timeout fallback, and telegram streamMode block", async () => {
  const { getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url });
  const { resolveAgentWorkspaceDir } = await import("../agents/agent-scope.js");
  return withOpenClawTestState(
    { label: "reply-block-streaming", env: { OPENCLAW_TEST_FAST: "1" } },
    async (state) => {
      const cfg = createReplyConfig(state);
      const streamModeCfg = createReplyConfig(state, "block");

      // Check both configs with pure resolvers before either reply can mkdir or probe SQLite.
      for (const config of [cfg, streamModeCfg]) {
        const storePath = expectDefined(config.session?.store, "block-streaming session store");
        const sqliteTarget = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
        expect(isPathInside(state.root, sqliteTarget.path)).toBe(true);
        expect(isPathInside(state.root, resolveAgentWorkspaceDir(config, "main"))).toBe(true);
      }

      const onReplyStart = vi.fn().mockResolvedValue(undefined);
      const onBlockReply = vi.fn().mockResolvedValue(undefined);

      runPreparedReply.mockImplementationOnce(async (params) => {
        await params.opts?.onReplyStart?.();
        await params.opts?.onBlockReply?.({ text: "first\n\nsecond" });
      });

      const res = await getReplyFromConfig(
        { ...message, MessageSid: "msg-123" },
        { onReplyStart, onBlockReply, disableBlockStreaming: false },
        cfg,
      );

      expect(res).toBeUndefined();
      expect(runPreparedReply).toHaveBeenCalledTimes(1);
      expect(onReplyStart).toHaveBeenCalledTimes(1);
      expect(onBlockReply).toHaveBeenCalledWith({ text: "first\n\nsecond" });

      const onBlockReplyStreamMode = vi.fn().mockResolvedValue(undefined);
      runPreparedReply.mockImplementationOnce(async () => [{ text: "final" }]);

      const resStreamMode = await getReplyFromConfig(
        { ...message, MessageSid: "msg-127" },
        { onBlockReply: onBlockReplyStreamMode },
        streamModeCfg,
      );

      const streamPayload = Array.isArray(resStreamMode) ? resStreamMode[0] : resStreamMode;
      expect(streamPayload?.text).toBe("final");
      expect(onBlockReplyStreamMode).not.toHaveBeenCalled();
    },
  );
});
