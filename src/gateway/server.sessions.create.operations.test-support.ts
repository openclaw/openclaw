import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect } from "vitest";
import type { SessionsCreateResult } from "../../packages/gateway-protocol/src/schema/sessions.js";
import { getRuntimeConfig } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import {
  disposeSessionReadContexts,
  identifiedClient,
  initializeSessionReadContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { testState } from "./test-helpers.js";
import { releaseGatewaySessionStoreFixture } from "./test/server-sessions-resources.test-helpers.js";

// Independent wire fixtures, not the production ID parser/generator. A UUIDv7's
// first 48 bits encode exactly the operation's issuance milliseconds.
export function creationIntent(issuedAt = Date.now(), sequence = 1, separator = ":") {
  const timestamp = issuedAt.toString(16).padStart(12, "0");
  const nonce = sequence.toString(16).padStart(32, "0");
  return {
    agentId: "main",
    creationOperationId: `v1${separator}${issuedAt}${separator}${nonce}`,
    sessionId: `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${nonce.slice(-12)}`,
  };
}

export async function operationContext(
  getConfig: () => OpenClawConfig,
  overrides: Partial<GatewayRequestContext> = {},
) {
  const context = createDirectChatContext({ getRuntimeConfig: getConfig, ...overrides });
  context.readPreparedGatewayModelCatalog = async () => {
    const catalog = await context.loadGatewayModelCatalogSnapshot();
    return { entries: catalog.entries, routeVariants: catalog.routeVariants };
  };
  await initializeSessionReadContext(context);
  return context;
}

export async function operationFixture(
  createStore: () => Promise<{ dir: string; storePath: string }>,
  cloudWorkers?: OpenClawConfig["cloudWorkers"],
  administrative = false,
) {
  const store = await createStore();
  const base = getRuntimeConfig();
  let config: OpenClawConfig = {
    ...base,
    agents: {
      ownership: "explicit",
      entries: { main: {} },
      defaults: {
        ...base.agents?.defaults,
        systemAgent: { agentId: "main" },
        sessionStore: { agentId: "main" },
      },
    },
    cloudWorkers,
    gateway: {
      ...base.gateway,
      roles: {
        default: "creator",
        definitions: {
          creator: {
            agents: ["main"],
            sessions: { others: "none" },
            scopes: administrative ? ["operator.admin"] : ["operator.read", "operator.write"],
          },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(config);
  const owner = ensureProfileForEmail("durable-creator@example.invalid");
  const client = identifiedClient(owner.id);
  if (administrative) {
    client.connect.scopes = ["operator.admin"];
  }
  const getConfig = () => config;
  return {
    ...store,
    owner,
    client,
    getConfig,
    setConfig(next: OpenClawConfig) {
      config = next;
      setRuntimeConfigSnapshot(config);
    },
    context: await operationContext(getConfig),
    makeContext: (overrides?: Partial<GatewayRequestContext>) =>
      operationContext(getConfig, overrides),
    async reopen() {
      // Retire projections and actual database workers, not just the RPC cache.
      await disposeSessionReadContexts();
      await releaseGatewaySessionStoreFixture(store.dir);
      testState.sessionStorePath = store.storePath;
      setRuntimeConfigSnapshot(config);
      return await operationContext(getConfig);
    },
  };
}

// Real registry, scope/role authorization and lifecycle admission. The shared WS
// connector does not authenticate selected profiles; wire auth remains separate proof.
export async function operationRequest(
  context: GatewayRequestContext,
  client: GatewayClient,
  method: string,
  params: Record<string, unknown>,
) {
  const responses: Parameters<RespondFn>[] = [];
  await handleGatewayRequest({
    req: { type: "req", id: "durable-" + method, method, params },
    client,
    context,
    isWebchatConnect: () => false,
    respond: (...response) => responses.push(response),
  });
  await flushPendingSessionsChangedEvents(context);
  expect(responses).toHaveLength(1);
  const [ok, payload, error] = responses[0]!;
  return { ok, payload, error };
}

export function successfulCreation(result: Awaited<ReturnType<typeof operationRequest>>) {
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  const payload = expectDefined(result.payload, "creation response") as SessionsCreateResult;
  expect(payload.sessionId).toEqual(expect.any(String));
  return { ...payload, sessionId: expectDefined(payload.sessionId, "physical session ID") };
}

export async function expectEmptyCreation(storePath: string, key: string, sessionId: string) {
  const target = { agentId: "main", sessionKey: key, sessionId, storePath };
  expect(loadSessionEntry(target)?.sessionId).toBe(sessionId);
  expect(await loadTranscriptEvents(target)).toEqual([
    expect.objectContaining({ type: "session", id: sessionId }),
  ]);
}
