import "../agents/subagents/spawn/subagent-spawn-model.mocks.shared.js";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { createSessionsSpawnTool } from "../agents/tools/sessions-spawn-tool.js";
import { listSessionEntriesCore, loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import { rollBackUnstartedSpawnChild } from "./server-methods/session-create-spawn.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import { agentDiscoveryMock, testState } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const parentKey = "agent:main:visible-parent";
let storePath: string;

beforeEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  testState.sessionConfig = {
    sendPolicy: {
      default: "allow",
      rules: [{ action: "deny", match: { keyPrefix: "agent:main:dashboard:" } }],
    },
  };
  ({ storePath } = await createSessionStoreDir());
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const { provider, model } = resolveDefaultModelForAgent({
    cfg: getRuntimeConfig(),
    agentId: "main",
  });
  agentDiscoveryMock.models = [{ provider, id: model, name: "Fixture model", reasoning: false }];
});

afterEach(async () => {
  testState.sessionConfig = undefined;
  await disposeSessionReadContexts();
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

function adminControlUiClient(): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        version: "test",
        platform: "web",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
      scopes: ["operator.admin"],
    },
  } as GatewayClient;
}

function writeOnlyOperatorClient(): GatewayClient {
  const profile = ensureProfileForEmail("write-operator@example.test");
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-android", version: "test", platform: "android", mode: "node" },
      role: "operator",
      scopes: ["operator.approvals", "operator.questions", "operator.read", "operator.write"],
    },
    authenticatedUserId: profile.id,
    authenticatedUserProfile: {
      profileId: profile.id,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  } as GatewayClient;
}

test.each([
  { caller: "admin Control UI", createClient: adminControlUiClient },
  { caller: "write-only operator", createClient: writeOnlyOperatorClient },
])(
  "visible spawn by $caller reports the child start rejection and leaves no child",
  async ({ createClient }) => {
    const client = createClient();
    const parent = await directSessionReq(
      "sessions.create",
      { key: parentKey, agentId: "main" },
      { client },
    );
    expect(parent.ok, JSON.stringify(parent.error)).toBe(true);
    const { getRuntimeConfig } = await getGatewayConfigModule();
    const context = createDirectChatContext({
      getRuntimeConfig,
      trackExecution: async (run) => await run(),
    });
    const tool = createSessionsSpawnTool({
      agentSessionKey: parentKey,
      config: getRuntimeConfig(),
      registerRun: vi.fn(),
      countActiveRuns: () => 0,
    });

    await expect(
      withPluginRuntimeGatewayRequestScope(
        { client, isWebchatConnect: () => false, resolveGatewayContext: () => context },
        () => tool.execute("denied-child", { task: "Inspect", visible: true }),
      ),
    ).rejects.toThrow("send blocked by session policy");
    expect(
      listSessionEntriesCore({ agentId: "main", storePath }).map(({ sessionKey }) => sessionKey),
    ).toEqual([parentKey]);
  },
);

test("unstarted spawn rollback keeps a child whose lifecycle changed", async () => {
  const childKey = "agent:main:dashboard:changed-child";
  const client = adminControlUiClient();
  const created = await directSessionReq<{ sessionId: string; entry: SessionEntry }>(
    "sessions.create",
    { key: childKey, agentId: "main" },
    { client },
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const reset = await directSessionReq("sessions.reset", { key: childKey }, { client });
  expect(reset.ok, JSON.stringify(reset.error)).toBe(true);
  const { getRuntimeConfig } = await getGatewayConfigModule();

  const removed = await rollBackUnstartedSpawnChild({
    client: null,
    context: createDirectChatContext({ getRuntimeConfig }),
    assertCurrent: () => {},
    key: childKey,
    agentId: "main",
    sessionId: created.payload!.sessionId,
    lifecycleRevision: created.payload!.entry.lifecycleRevision,
  });

  expect(removed).toBe(false);
  const kept = loadSessionEntry({ agentId: "main", sessionKey: childKey, storePath });
  expect(kept?.sessionId).toBe(created.payload!.sessionId);
  expect(kept?.lifecycleRevision).not.toBe(created.payload!.entry.lifecycleRevision);
});
