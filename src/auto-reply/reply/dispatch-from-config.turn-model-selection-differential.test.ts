import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import {
  TURN_MODEL_DEFAULT_REF,
  TURN_MODEL_DIFFERENTIAL_FIXTURES,
  TURN_MODEL_OVERRIDE_REF,
  turnModelRefLabel,
  type TurnModelDifferentialFixture,
} from "../../test-utils/turn-model-selection-differential.js";
import { buildTestCtx } from "./test-ctx.js";

const selectAgentHarnessMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/harness/selection-decision.js", () => ({
  resolveAgentHarnessDeliveryDefaults: (...args: unknown[]) => selectAgentHarnessMock(...args),
}));

const { resolveVisibleRepliesPolicy } = await import("./dispatch-from-config.harness-defaults.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function expectHarnessSelection(fixture: TurnModelDifferentialFixture) {
  const storePath = path.join(tempDirs.make("turn-model-harness-"), "sessions.json");
  const sessionKey = "agent:main:telegram:group:selection";
  if (fixture.parent) {
    replaceSessionEntrySync(
      { agentId: "main", storePath, sessionKey: fixture.parent.key },
      fixture.parent.entry,
    );
  }

  selectAgentHarnessMock.mockClear();
  resolveVisibleRepliesPolicy({
    cfg: {
      session: { store: storePath },
      agents: { defaults: { model: { primary: turnModelRefLabel(TURN_MODEL_DEFAULT_REF) } } },
      channels: fixture.modelByChannel ? { modelByChannel: fixture.modelByChannel } : undefined,
    },
    // Visible-reply defaults are queried only for direct delivery. The stored
    // chat type still drives the real channel matcher for group fixtures.
    chatType: "direct",
    ctx: buildTestCtx({ SessionKey: sessionKey, ...fixture.ctx }),
    entry: fixture.child,
    sessionAgentId: "main",
    sessionKey,
    turnModelOverride: fixture.heartbeat ? turnModelRefLabel(TURN_MODEL_OVERRIDE_REF) : undefined,
  });
  const { provider, model } = fixture.expected.harness;
  expect(selectAgentHarnessMock).toHaveBeenLastCalledWith(
    expect.objectContaining({ provider, modelId: model }),
  );
}

describe("turn model selection harness-path differential", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createSessionConversationTestRegistry());
    selectAgentHarnessMock.mockReturnValue({ visibleReplies: "automatic" });
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it.each(
    TURN_MODEL_DIFFERENTIAL_FIXTURES.filter(
      ({ name }) => name !== "default only" && name !== "locked stored selection",
    ),
  )("pins observed $name behavior", (fixture) => {
    expectHarnessSelection(fixture);
  });

  it.each([
    { pluginOwnerId: "model-owner", expectedPin: undefined, expectedOverride: "openclaw" },
    { pluginOwnerId: undefined, expectedPin: "codex", expectedOverride: "codex" },
  ])(
    "preserves the delivery-policy owner with pluginOwnerId=$pluginOwnerId",
    ({ pluginOwnerId, expectedPin, expectedOverride }) => {
      selectAgentHarnessMock.mockClear();
      resolveVisibleRepliesPolicy({
        cfg: {
          agents: { defaults: { model: { primary: "openai/dispatch-model" } } },
        },
        chatType: "direct",
        ctx: buildTestCtx({ Provider: "openai" }),
        entry: {
          sessionId: "owned-session",
          updatedAt: 100,
          agentHarnessId: "codex",
          agentRuntimeOverride: "openclaw",
          modelSelectionLocked: true,
          pluginOwnerId,
        },
        sessionAgentId: "main",
      });

      expect(selectAgentHarnessMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          agentHarnessId: expectedPin,
          agentHarnessRuntimeOverride: expectedOverride,
        }),
      );
    },
  );

  it("resolves turn aliases in the session agent scope", () => {
    const sessionKey = "agent:worker:telegram:group:selection";
    const cfg = {
      agents: {
        defaults: {
          model: "openai/global-model",
          models: {
            "openai/global-model": { alias: "fast" },
          },
        },
        entries: {
          worker: {
            models: {
              "anthropic/worker-model": { alias: "fast" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    selectAgentHarnessMock.mockClear();
    resolveVisibleRepliesPolicy({
      cfg,
      chatType: "direct",
      ctx: buildTestCtx({ SessionKey: sessionKey }),
      entry: { sessionId: "worker-session", updatedAt: Date.now() },
      sessionAgentId: "worker",
      sessionKey,
      turnModelOverride: "fast",
    });

    expect(selectAgentHarnessMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        modelId: "worker-model",
        agentId: "worker",
      }),
    );
  });
});
