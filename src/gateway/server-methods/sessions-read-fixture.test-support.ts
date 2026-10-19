import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import { addSubagentRunForTests } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import {
  captureRpcTargetForTest,
  createActiveRpcSourceForTest,
} from "./rpc-source-fixtures.test-support.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./sessions-read-cache.test-support.js";

export function ownedSessionEntry(
  sessionId: string,
  updatedAt: number,
  ownerId = "owner@example.com",
): SessionEntry {
  return {
    sessionId,
    updatedAt,
    visibility: "shared",
    createdActor: { type: "human", source: "profile", id: ownerId },
  };
}

export function sessionReader(
  config: OpenClawConfig,
  profileId = "owner@example.com",
  context = requestContext(config),
  acceptsSerializedJson?: boolean,
) {
  const client = identifiedClient(profileId);
  return {
    client,
    context,
    list: (request: SessionsListParams) =>
      listSessions({ client, context, request, acceptsSerializedJson }),
  };
}

export function addReadSubagent(
  runId: string,
  childSessionKey: string,
  parent: string,
  overrides: Partial<Parameters<typeof addSubagentRunForTests>[0]> = {},
) {
  return addSubagentRunForTests({
    runId,
    childSessionKey,
    controllerSessionKey: parent,
    requesterSessionKey: parent,
    requesterDisplayKey: parent,
    task: "Current child task",
    cleanup: "keep",
    createdAt: 1,
    startedAt: 2,
    ...overrides,
  });
}

export async function activateReadSession(
  _context: ReturnType<typeof requestContext>,
  runId: string,
  agentId: string,
  sessionKey: string,
  sessionId: string,
) {
  const target = { agentId, sessionKey, sessionId };
  const storeScope = captureRpcTargetForTest(target).storeScope;
  const source = await createActiveRpcSourceForTest({}, { ...target, storeScope, runId });
  rpcSourceTesting.set(runId, source);
}
