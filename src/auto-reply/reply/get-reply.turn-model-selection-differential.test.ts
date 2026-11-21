import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target-paths.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { isPathInside } from "../../infra/path-guards.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as turn from "../../test-utils/turn-model-selection-differential.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import * as replyFixtures from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
  resolveReplyDirectives: vi.fn(),
}));

replyFixtures.registerGetReplyBaselineBypass();
replyFixtures.registerGetReplyRuntimeOverrides(mocks);

let state: OpenClawTestState;

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let resolveAgentWorkspaceDirMock: typeof import("../../agents/agent-scope.js").resolveAgentWorkspaceDir;
let resolveDefaultModelMock: typeof import("./directive-handling.defaults.js").resolveDefaultModel;
let resolveChannelModelOverrideMock: typeof import("../../channels/model-overrides.js").resolveChannelModelOverride;
let resolveModelRefFromStringMock: typeof import("../../agents/model-selection.js").resolveModelRefFromString;
let runPreparedReplyMock: typeof import("./get-reply-run.js").runPreparedReply;

async function observeReplySelection(
  fixture: Omit<turn.TurnModelDifferentialFixture, "expected">,
  sessionKey: string,
): Promise<turn.TurnModelSelectionVerdict> {
  const storePath = path.join(state.sessionsDir("main"), "sessions.json");
  expect(
    isPathInside(state.root, resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath).path),
  ).toBe(true);
  const sessionStore: Record<string, SessionEntry> = { [sessionKey]: fixture.child };
  if (fixture.parent) {
    sessionStore[fixture.parent.key] = fixture.parent.entry;
  }
  for (const [key, entry] of Object.entries(sessionStore)) {
    replaceSessionEntrySync({ storePath, sessionKey: key }, entry);
  }
  const cfg = markCompleteReplyConfig({
    session: { store: storePath },
    agents: {
      defaults: {
        model: { primary: turn.turnModelRefLabel(turn.TURN_MODEL_DEFAULT_REF) },
        modelPolicy: { allow: ["*/*"] },
        workspace: state.workspaceDir,
      },
    },
    channels: fixture.modelByChannel ? { modelByChannel: fixture.modelByChannel } : undefined,
  });
  mocks.initSessionState.mockResolvedValue(
    replyFixtures.createGetReplySessionState({
      sessionCtx: fixture.ctx,
      sessionEntry: fixture.child,
      sessionStore,
      sessionKey,
      sessionId: fixture.child.sessionId,
      storePath,
      groupResolution:
        fixture.child.chatType === "group"
          ? { channel: undefined, id: fixture.child.groupId, type: "group" }
          : undefined,
      isGroup: fixture.child.chatType === "group",
      triggerBodyNormalized: "hello",
      bodyStripped: "hello",
    }),
  );
  vi.mocked(runPreparedReplyMock).mockClear();
  expect(isPathInside(state.root, resolveAgentWorkspaceDirMock(cfg, "main"))).toBe(true);
  await getReplyFromConfig(
    replyFixtures.buildGetReplyCtx({ SessionKey: sessionKey, ...fixture.ctx }),
    fixture.turnModelOverride
      ? {
          modelOverride: turn.turnModelRefLabel(turn.TURN_MODEL_OVERRIDE_REF),
        }
      : undefined,
    cfg,
  );
  const selected = expectDefined(
    vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0],
    `reply path did not prepare a run for ${fixture.name}`,
  );
  return turn.turnModelVerdict(
    { provider: selected.provider, model: selected.model },
    fixture.locked ? "locked" : undefined,
  );
}

beforeAll(async () => {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  ({ resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock } =
    await import("../../agents/agent-scope.js"));
  ({ resolveDefaultModel: resolveDefaultModelMock } =
    await import("./directive-handling.defaults.js"));
  ({ resolveChannelModelOverride: resolveChannelModelOverrideMock } =
    await import("../../channels/model-overrides.js"));
  ({ resolveModelRefFromString: resolveModelRefFromStringMock } =
    await import("../../agents/model-selection.js"));
  ({ runPreparedReply: runPreparedReplyMock } = await import("./get-reply-run.js"));
});

beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "turn-model-reply",
    env: { OPENCLAW_TEST_FAST: "1" },
  });
  const actualChannelModel = await vi.importActual<
    typeof import("../../channels/model-overrides.js")
  >("../../channels/model-overrides.js");
  const actualModelSelection = await vi.importActual<
    typeof import("../../agents/model-selection.js")
  >("../../agents/model-selection.js");
  vi.mocked(resolveChannelModelOverrideMock).mockImplementation(
    actualChannelModel.resolveChannelModelOverride,
  );
  vi.mocked(resolveModelRefFromStringMock).mockImplementation(
    actualModelSelection.resolveModelRefFromString,
  );
  vi.mocked(resolveDefaultModelMock).mockReturnValue({
    defaultProvider: turn.TURN_MODEL_DEFAULT_REF.provider,
    defaultModel: turn.TURN_MODEL_DEFAULT_REF.model,
    aliasIndex: actualModelSelection.buildModelAliasIndex({
      cfg: {},
      defaultProvider: turn.TURN_MODEL_DEFAULT_REF.provider,
    }),
  });
  mocks.resolveReplyDirectives.mockImplementation(
    async (params: {
      provider: string;
      model: string;
      sessionKey: string;
      triggerBodyNormalized: string;
    }) =>
      replyFixtures.createGetReplyContinueDirectivesResult({
        body: params.triggerBodyNormalized,
        abortKey: params.sessionKey,
        from: "sender",
        to: "target",
        senderId: "sender",
        commandSource: "text",
        senderIsOwner: true,
        resetHookTriggered: false,
        provider: params.provider,
        model: params.model,
      }),
  );
  mocks.handleInlineActions.mockImplementation(
    async (params: { directives?: unknown; cleanedBody?: string }) => ({
      kind: "continue",
      directives: params.directives ?? {},
      cleanedBody: params.cleanedBody ?? "hello",
      abortedLastRun: false,
    }),
  );
  vi.mocked(runPreparedReplyMock).mockResolvedValue({ text: "ok" });
});

afterEach(() => state.cleanup());

it("selects the live channel exact conversation", async () => {
  const fixture = {
    name: "live channel exact conversation",
    ctx: {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      ChatType: "group",
      SenderId: "live-peer",
    },
    child: turn.createTurnModelEntry({ chatType: "group", groupId: "room" }),
    modelByChannel: {
      telegram: {
        room: turn.turnModelRefLabel(turn.TURN_MODEL_LIVE_CHANNEL_REF),
        "*": turn.turnModelRefLabel(turn.TURN_MODEL_CHANNEL_REF),
      },
    },
  };
  await expect(observeReplySelection(fixture, "agent:main:telegram:group:room")).resolves.toEqual(
    turn.turnModelVerdict(turn.TURN_MODEL_LIVE_CHANNEL_REF),
  );
});
const fixtures = turn.TURN_MODEL_DIFFERENTIAL_FIXTURES.filter(
  ({ name }) =>
    name === "explicit turn override" ||
    name === "explicit default rejects stale child and parent overrides",
);
it.each(fixtures)("pins observed $name behavior", async (fixture) => {
  await expect(
    observeReplySelection(fixture, "agent:main:telegram:group:selection"),
  ).resolves.toEqual(fixture.expected.reply);
});
