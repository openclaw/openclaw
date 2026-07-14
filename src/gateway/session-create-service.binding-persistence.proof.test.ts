// Real-behavior proof for #106778 / PR #106932.
//
// This test wires the REAL gateway dispatch entrypoint
// (`emitGatewaySessionEndPluginHook` — the exact function `createGatewaySession`
// calls) through the REAL global hook runner into the REAL Codex extension
// `session_end` handler over a REAL Codex binding store. Nothing on the
// destructive path is mocked; there is no OpenAI turn and no auth.
//
// It demonstrates the persisted-state consequence the ClawSweeper review asked
// about: the parent's Codex binding is genuinely retired when the gateway emits
// `session_end(reason:"new")` on it — precisely what an un-gated detached
// dashboard-child creation did (#106778). The fix's `childSucceedsParent` gate
// (proven by the focused unit suites) stops that emit for a dashboard child, so
// the binding is never touched.

import { afterEach, describe, expect, it } from "vitest";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import codexPlugin from "../../extensions/codex/index.js";
import {
  createCodexAppServerBindingStore,
  sessionBindingIdentity,
} from "../../extensions/codex/src/app-server/session-binding.js";
import { createCodexTestBindingStateStore } from "../../extensions/codex/src/app-server/session-binding.test-helpers.js";
import { emitGatewaySessionEndPluginHook } from "./session-reset-service.js";
import { initializeGlobalHookRunner, resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const PARENT_KEY = "agent:main:main";
const PARENT_SID = "parent-sess-0001";
const identity = sessionBindingIdentity({
  agentId: "main",
  sessionId: PARENT_SID,
  sessionKey: PARENT_KEY,
});

// Activate the real Codex extension, capture its real session_end handler and
// binding store, and register that handler in the real global hook runner so the
// gateway emit path reaches it exactly as it would in production.
function wireCodexIntoGatewayHookRunner() {
  const stateStore = createCodexTestBindingStateStore();
  const bindingStore = createCodexAppServerBindingStore(stateStore);
  const handlers: Array<[string, (...a: unknown[]) => unknown]> = [];
  codexPlugin.register(
    createTestPluginApi({
      id: "codex",
      name: "Codex",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: { state: { openSyncKeyedStore: () => stateStore } } as never,
      registerAgentHarness: () => {},
      registerCommand: () => {},
      registerMediaUnderstandingProvider: () => {},
      registerMigrationProvider: () => {},
      registerProvider: () => {},
      on: (name: string, fn: (...a: unknown[]) => unknown) => {
        handlers.push([name, fn]);
      },
    } as never),
  );
  const sessionEnd = handlers.find(([name]) => name === "session_end")?.[1];
  if (!sessionEnd) {
    throw new Error("Codex extension registered no session_end handler");
  }
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "session_end", handler: sessionEnd }]),
  );
  return { bindingStore };
}

// Drive the real gateway emit exactly as createGatewaySession does on rollover.
function gatewayEmitParentSessionEnd(reason: "new" | "shutdown") {
  emitGatewaySessionEndPluginHook({
    cfg: {} as never,
    sessionKey: PARENT_KEY,
    sessionId: PARENT_SID,
    storePath: "/tmp/proof-nonexistent",
    agentId: "main",
    reason,
    nextSessionId: "child-sess-0002",
    nextSessionKey: "agent:main:dashboard:child-0002",
  });
}

describe("real gateway -> Codex binding persistence (#106778 / PR #106932)", () => {
  afterEach(() => {
    resetGlobalHookRunner();
  });

  it('retires the parent Codex binding when the gateway emits session_end(reason:"new") — the #106778 bug', async () => {
    const { bindingStore } = wireCodexIntoGatewayHookRunner();
    await bindingStore.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-parent", cwd: "/repo" },
    });
    expect(await bindingStore.read(identity)).toMatchObject({ threadId: "thread-parent" });

    gatewayEmitParentSessionEnd("new");
    await sleep(250); // the gateway emit runs its hook on a fire-and-forget continuation

    // The real gateway -> global hook runner -> Codex extension -> binding store
    // chain retired the still-active parent's binding. This is exactly the
    // persisted mutation #106778 reports ("state":"cleared","retired":true).
    expect(await bindingStore.read(identity)).toBeUndefined();
  });

  it("preserves the parent binding for a non-terminal reason (retirement is reason-selective, not a blanket wipe)", async () => {
    const { bindingStore } = wireCodexIntoGatewayHookRunner();
    await bindingStore.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-parent", cwd: "/repo" },
    });

    gatewayEmitParentSessionEnd("shutdown");
    await sleep(250);

    // "shutdown" is not in ENDED_SESSION_REASONS, so the same real chain leaves
    // the binding intact — proving the retirement above is a genuine, selective
    // store mutation rather than an artifact of the harness.
    expect(await bindingStore.read(identity)).toMatchObject({ threadId: "thread-parent" });
  });
});
