import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import * as models from "../../test-utils/turn-model-selection-differential.js";
import { buildTestCtx } from "./test-ctx.js";

const selectHarness = vi.hoisted(() => vi.fn());
// mock-isolation: capture harness selection without loading a provider runtime.
vi.mock("../../agents/harness/selection-decision.js", () => ({
  resolveAgentHarnessDeliveryDefaults: (...args: unknown[]) => selectHarness(...args),
}));
const { resolveVisibleRepliesPolicy } = await import("./dispatch-from-config.harness-defaults.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createSessionConversationTestRegistry());
  selectHarness.mockReset().mockReturnValue({ visibleReplies: "automatic" });
});
afterEach(resetPluginRuntimeStateForTest);

it.each([
  ...models.TURN_MODEL_DIFFERENTIAL_FIXTURES.filter(
    ({ name }) =>
      name === "heartbeat or explicit turn override" ||
      name === "parent persisted override versus channel" ||
      name === "explicit default rejects stale child and parent overrides",
  ).map((fixture) => ({ name: fixture.name, fixture })),
  { name: "turn aliases in the session agent scope", fixture: undefined },
])("pins observed $name behavior", async ({ fixture }) => {
  const agentId = fixture ? "main" : "worker";
  const sessionKey = `agent:${agentId}:telegram:group:selection`;
  const storePath = path.join(tempDirs.make("turn-model-harness-"), "sessions.json");
  if (fixture?.parent) {
    replaceSessionEntrySync(
      { agentId: "main", storePath, sessionKey: fixture.parent.key },
      fixture.parent.entry,
    );
  }
  const aliased = (model: string) => ({ models: { [model]: { alias: "fast" } } });
  const cfg = fixture
    ? {
        session: { store: storePath },
        agents: {
          defaults: { model: { primary: models.turnModelRefLabel(models.TURN_MODEL_DEFAULT_REF) } },
        },
        channels: fixture.modelByChannel ? { modelByChannel: fixture.modelByChannel } : undefined,
      }
    : ({
        agents: {
          defaults: { model: "openai/global-model", ...aliased("openai/global-model") },
          entries: { worker: aliased("anthropic/worker-model") },
        },
      } as unknown as OpenClawConfig);
  await resolveVisibleRepliesPolicy({
    cfg,
    // Stored group context controls channel matching; direct delivery queries harness defaults.
    chatType: "direct",
    ctx: buildTestCtx({ SessionKey: sessionKey, ...fixture?.ctx }),
    entry: fixture?.child ?? { sessionId: "worker-session", updatedAt: Date.now() },
    sessionAgentId: agentId,
    sessionKey,
    turnModelOverride: fixture
      ? fixture.heartbeat
        ? models.turnModelRefLabel(models.TURN_MODEL_OVERRIDE_REF)
        : undefined
      : "fast",
  });
  expect(selectHarness).toHaveBeenLastCalledWith(
    expect.objectContaining(
      fixture
        ? { provider: fixture.expected.harness.provider, modelId: fixture.expected.harness.model }
        : { provider: "anthropic", modelId: "worker-model", agentId: "worker" },
    ),
  );
});
