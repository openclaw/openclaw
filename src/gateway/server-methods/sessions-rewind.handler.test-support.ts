import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import type { AgentHarness } from "../../agents/harness/types.js";
import { harnessRegistry } from "../../agents/model-catalog-fixtures.test-support.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { runSessionMutation } from "../../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../../state/user-profile-writes.js";
import { gatewayProfile } from "../server/client-fixtures.test-support.js";
import { sessionRewindHandlers } from "./sessions-rewind.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

export {
  expectRpcError as expectCutFailure,
  expectRpcResult as expectCutReply,
} from "./rpc-response.test-support.js";

export const sessionKey = "agent:main:rewind-handler";
export const sourceSessionId = "rewind-handler-source";
export const cfg = { agents: { entries: { main: {} } } };
export function sessionRoleConfig(
  name: string,
  definition: GatewayOperatorRoleDefinition,
): OpenClawConfig {
  return { gateway: { roles: { default: name, definitions: { [name]: definition } } } };
}

export function installHarness(
  overrides: Partial<AgentHarness>,
  registerPlugin = false,
  id = "test-harness",
) {
  const registry = harnessRegistry(id, {
    label: "Test harness",
    supports: () => ({ supported: false }),
    runAttempt: async () => {
      throw new Error("not used");
    },
    ...overrides,
  });
  registry.agentHarnesses[0]!.source = "runtime";
  if (registerPlugin) {
    registry.plugins.push(createPluginRecord({ id }));
  }
  setActivePluginRegistry(registry);
}

export async function holdLifecycle(
  storePath: string,
  sessionId: string,
  afterRelease?: () => Promise<void>,
) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const settled = runSessionMutation({
    scope: storePath,
    identities: [sessionId],
    run: async () => {
      entered.resolve();
      await release.promise;
      await afterRelease?.();
    },
  });
  await entered.promise;
  return { release: () => release.resolve(), settled };
}
type MessageCutMethod =
  | "sessions.branches.list"
  | "sessions.branches.switch"
  | "sessions.fork"
  | "sessions.rewind";

export function messageCutContext(config: OpenClawConfig = cfg): GatewayRequestContext {
  return {
    broadcastToConnIds: vi.fn(),
    getRuntimeConfig: () => config,
    getSessionEventSubscriberConnIds: () => new Set(),
  } as unknown as GatewayRequestContext;
}

export function messageCutParams(method: MessageCutMethod, key: string, entryId: string) {
  if (method === "sessions.branches.list") {
    return { sessionKey: key };
  }
  return method === "sessions.branches.switch"
    ? { sessionKey: key, leafEntryId: entryId }
    : { sessionKey: key, entryId };
}

export async function invokeHandler(
  method: MessageCutMethod,
  entryId = "user-entry",
  options: Partial<GatewayRequestHandlerOptions> = {},
) {
  const respond = vi.fn();
  const handler = expectDefined(sessionRewindHandlers[method], `${method} handler`);
  await handler({
    req: { id: `${method}-request` } as never,
    params: messageCutParams(method, sessionKey, entryId),
    respond,
    context: messageCutContext(),
    client: null,
    isWebchatConnect: () => false,
    ...options,
  });
  return respond;
}

export async function restrictedOperator(
  email: string,
  agentId: string,
  sandbox?: "required",
  fullProtocol = true,
) {
  const profile = await ensureCanonicalUserProfileForEmail(email);
  await setCanonicalUserProfileRole(profile.id, "guest");
  const client = {
    connect: {
      ...(fullProtocol && {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "test", version: "test", platform: "test", mode: "test" },
      }),
      scopes: ["operator.write"],
    },
    authenticatedUserProfile: gatewayProfile(profile.id, profile.displayName, profile.updatedAt),
  } as GatewayClient;
  const roles = sessionRoleConfig("guest", {
    sessions: { others: "view" },
    agents: [agentId],
    scopes: ["operator.read", "operator.write"],
    ...(sandbox ? { sandbox } : {}),
  });
  const context = messageCutContext({ ...cfg, ...roles });
  return { profile, options: { client, context } };
}
