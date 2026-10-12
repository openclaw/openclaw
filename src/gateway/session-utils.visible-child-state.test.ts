import "./session-utils-provider.test-support.js";
import { afterEach, expect, test } from "vitest";
import { resetConfigRuntimeState } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { buildSessionRowFixture } from "./session-list.test-support.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";

afterEach(() => {
  resetConfigRuntimeState();
  resetPluginRuntimeStateForTest();
});

// A visible child is created with its model and thinking persisted together;
// the session row must project that pair with the runtime the child's agent
// actually selects for the model.
test("projects a visible child's persisted model, runtime, and thinking consistently", () => {
  const cfg = {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.6-sol" },
        thinkingDefault: "xhigh",
        models: {
          "openai/gpt-5.6-luna": {
            params: { thinking: "off" },
            agentRuntime: { id: "openclaw" },
          },
        },
      },
      entries: {
        main: {
          models: {
            "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
          },
        },
      },
    },
  } as OpenClawConfig;

  const row = buildSessionRowFixture({
    cfg,
    storePath: "",
    store: {},
    key: "agent:main:dashboard:child",
    entry: {
      sessionId: "visible-child",
      parentSessionKey: "agent:main:main",
      providerOverride: "openai",
      modelOverride: "gpt-5.6-luna",
      modelOverrideSource: "user",
      thinkingLevel: "max",
    } as SessionEntry,
    rowContext: buildSessionListRowMetadataContext({ now: 1 }),
    lightweightListRow: false,
  });

  expect(row).toMatchObject({
    modelProvider: "openai",
    model: "gpt-5.6-luna",
    thinkingLevel: "max",
    agentRuntime: { id: "codex" },
  });
});
