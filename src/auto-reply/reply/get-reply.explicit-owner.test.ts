import { afterEach, expect, it, vi } from "vitest";
import { resolvePromptBuildHookResult } from "../../agents/embedded-agent-runner/run/attempt-prompt-helpers.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";

let state: OpenClawTestState | undefined;
afterEach(async () => {
  await state?.cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

async function createExplicitOwnerConfig() {
  state = await createOpenClawTestState({
    label: "explicit-reply",
    env: { OPENCLAW_TEST_FAST: "0" },
  });
  const cfg = withFullRuntimeReplyConfig({
    agents: {
      ownership: "explicit",
      entries: {
        main: { workspace: state.path("main-workspace") },
        work: { workspace: state.path("work-workspace") },
      },
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: { primary: "mock-openai/gpt-5.6-luna" },
        models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
      },
    },
    plugins: { enabled: false },
    session: { scope: "global" },
  });
  await state.writeConfig(cfg);
  return cfg;
}

it.each(["main", "work"])(
  "consumes only %s global next-turn context during prompt preparation",
  async (agentId) => {
    const cfg = await createExplicitOwnerConfig();
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createPluginRecord({ id: "injector", status: "loaded" }));
    for (const owner of ["main", "work"]) {
      await replaceSessionEntry(
        { agentId: owner, sessionKey: "global" },
        {
          sessionId: `${owner}-global`,
          updatedAt: 1,
          pluginNextTurnInjections: {
            injector: [
              {
                id: owner,
                pluginId: "injector",
                text: `${owner} context`,
                placement: "prepend_context",
                createdAt: 1,
              },
            ],
          },
        },
      );
    }
    const prepare = () =>
      withPluginRuntimeRegistryScope(registry, () =>
        resolvePromptBuildHookResult({
          config: cfg,
          prompt: "hello",
          messages: [],
          hookCtx: { agentId, sessionKey: "global" },
        }),
      );
    expect((await prepare()).prependContext).toBe(`${agentId} context`);
    expect(
      loadSessionEntryReadOnly({ agentId, sessionKey: "global" })?.pluginNextTurnInjections,
    ).toBeUndefined();
    const otherAgentId = agentId === "main" ? "work" : "main";
    expect(
      loadSessionEntryReadOnly({ agentId: otherAgentId, sessionKey: "global" })
        ?.pluginNextTurnInjections?.injector,
    ).toEqual([expect.objectContaining({ text: `${otherAgentId} context` })]);
    expect((await prepare()).prependContext).toBeUndefined();
  },
);
