import { afterEach, expect, test, vi } from "vitest";
import { testState } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const titleMocks = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback: titleMocks.generate,
}));

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
afterEach(() => {
  titleMocks.generate.mockReset();
  testState.agentsConfig = undefined;
  testState.agentConfig = undefined;
  testState.sessionConfig = undefined;
});

test("sessions.create infers the child owner from an agent-prefixed parent", async () => {
  titleMocks.generate.mockResolvedValue("Generated Dashboard Title");
  await createSessionStoreDir();
  testState.agentsConfig = {
    ownership: "explicit",
    entries: { main: {}, ops: {} },
  };
  testState.agentConfig = {};
  // A non-main dmScope keeps this parent-only creation on the dashboard-child
  // path: the main dmScope resets the parent main session in place instead.
  testState.sessionConfig = { dmScope: "per-channel-peer" };
  const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  const parent = await directSessionReq<{ key?: string; sessionId?: string }>("sessions.create", {
    key: "agent:ops:main",
  });
  expect(parent.ok, JSON.stringify(parent)).toBe(true);

  const child = await directSessionReq<{
    key?: string;
    entry?: { parentSessionKey?: string; parentSessionId?: string };
  }>("sessions.create", {
    parentSessionKey: "agent:ops:main",
    emitCommandHooks: true,
    succeedsParent: false,
  });
  expect(child.ok, JSON.stringify(child)).toBe(true);
  expect(child.payload?.key).toMatch(/^agent:ops:dashboard:/u);
  expect(child.payload?.entry?.parentSessionKey).toBe("agent:ops:main");
  expect(child.payload?.entry?.parentSessionId).toBe(parent.payload?.sessionId);
});
