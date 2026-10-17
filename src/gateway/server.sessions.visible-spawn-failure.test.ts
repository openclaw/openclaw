import "../agents/subagents/spawn/subagent-spawn-model.mocks.shared.js";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { createSessionsSpawnTool } from "../agents/tools/sessions-spawn-tool.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import type { GatewayClient } from "./server-methods/client-types.js";
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

test("visible spawn reports the child start rejection and removes the child", async () => {
  const client = {
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

  const result = await withPluginRuntimeGatewayRequestScope(
    { client, isWebchatConnect: () => false, resolveGatewayContext: () => context },
    () => tool.execute("denied-child", { task: "Inspect", visible: true }),
  );

  expect(result.details).toMatchObject({
    status: "error",
    error: "send blocked by session policy. Session removed.",
  });
  const { childSessionKey } = result.details as { childSessionKey: string };
  expect(loadSessionEntry({ agentId: "main", sessionKey: childSessionKey, storePath })).toBe(
    undefined,
  );
});
