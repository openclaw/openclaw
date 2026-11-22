import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as databaseProcess from "../../infra/database-engine/admission-scope.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { getCanonicalUserPreferences } from "../../state/user-preferences.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import {
  createRequestGatewayMethodRegistry,
  handleGatewayRequest,
  runWithGatewayRequestEnvelope,
} from "../server-methods.js";
import { createOperatorClient } from "../server-plugin-in-process-dispatch.test-support.js";
import {
  createWorkerEnvironmentStore,
  type WorkerEnvironmentStore,
} from "../worker-environments/store.js";
import { agentsHandlers } from "./agents.js";
import { themeHandlers } from "./themes.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";
import { usersHandlers } from "./users.js";

let state: OpenClawTestState;
let store: WorkerEnvironmentStore;
let profile: Awaited<ReturnType<typeof prepareUserProfileCatalog>>;
let client: GatewayClient;
let context: GatewayRequestContext;
const ids = Array.from({ length: 15 }, (_, index) => `synthetic-${index}`);
const handlers = { ...themeHandlers, ...usersHandlers, ...agentsHandlers };
const ordinary = <T>(run: () => T) =>
  withPluginRuntimeGatewayRequestScope({ isWebchatConnect: () => false }, run);
const read = () =>
  executeExistingOpenClawStateRead(
    {},
    { type: "workerEnvironments.snapshot", input: { ids } },
    { current: true },
  );

beforeEach(async () => {
  vi.spyOn(databaseProcess, "getDatabaseProcessRole").mockReturnValue("gateway");
  state = await createOpenClawTestState({ layout: "state-only", prefix: "read-capacity-" });
  const profileId = ensureProfileForEmail("reader@example.test").id;
  profile = await prepareUserProfileCatalog();
  client = createOperatorClient({ profileId, scopes: ["operator.admin"] });
  client.internal = { authenticatedControlUi: true };
  context = createDirectChatContext({
    getRuntimeConfig: () => ({ agents: { defaults: { workspace: state.workspaceDir } } }),
  });
  store = await createWorkerEnvironmentStore();
  for (const environmentId of ids) {
    await store.createIntent({
      environmentId,
      providerId: "synthetic",
      profileId: "synthetic",
      profileSnapshot: { settings: {} },
      provisionOperationId: `create-${environmentId}`,
    });
  }
  await read();
});
afterEach(async () => {
  await store.close();
  profile.release();
  await state.cleanup();
  vi.restoreAllMocks();
});

function burst() {
  return ordinary(() => Promise.allSettled(Array.from({ length: 128 }, read)));
}

it("keeps authenticated Control UI reads available when background reads fill their allowance", async () => {
  for (const method of ["themes.list", "users.prefs.get", "agents.list"]) {
    let replies: unknown[] = [];
    let background: ReturnType<typeof burst> | undefined;
    await handleGatewayRequest({
      req: { type: "req", id: method, method, params: {} },
      client,
      context,
      isWebchatConnect: () => true,
      respond: (ok, payload, error) => {
        replies = [ok, payload, error];
      },
      extraHandlers: {
        [method]: async (options) => {
          background = burst();
          return handlers[method]!(options);
        },
      },
    });
    const outcomes = await background!;
    expect(replies[0], method).toBe(true);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(124);
    const refused = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(refused).toHaveLength(4);
    for (const outcome of refused) {
      expect(outcome.reason).toMatchObject({ code: "overloaded" });
    }
  }
});

it("does not lend UI headroom to ordinary, synthetic, unrelated, or expired request scopes", async () => {
  const options = {
    context,
    isWebchatConnect: () => true,
    methodRegistry: createRequestGatewayMethodRegistry(),
    reject: (error: unknown): never => {
      throw error;
    },
  };
  const preferences = () => getCanonicalUserPreferences(client.authenticatedUserProfile!.profileId);
  let expired: (() => Promise<unknown>) | undefined;
  await runWithGatewayRequestEnvelope(
    "themes.list",
    client,
    () => {
      const captured = AsyncLocalStorage.snapshot();
      expired = () => captured(preferences);
    },
    options,
  );
  const operationalRunInstance = { instanceId: "synthetic", runId: "synthetic" };
  const agentClient: GatewayClient = {
    ...client,
    internal: {
      ...client.internal,
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "agent:main:synthetic",
        operationalRunInstance,
        delegatedAuthority: {
          kind: "local",
          operationalRunInstance,
          lifecycleGeneration: "synthetic",
          claimId: "synthetic",
        },
      },
    },
  };
  for (const run of [
    () => preferences(),
    () =>
      runWithGatewayRequestEnvelope(
        "themes.list",
        { ...client, internal: {} },
        preferences,
        options,
      ),
    () =>
      runWithGatewayRequestEnvelope(
        "themes.list",
        { ...client, internal: { ...client.internal, syntheticClient: true } },
        preferences,
        options,
      ),
    () => runWithGatewayRequestEnvelope("themes.list", agentClient, preferences, options),
    () => runWithGatewayRequestEnvelope("users.prefs.set", client, preferences, options),
    () =>
      runWithGatewayRequestEnvelope(
        "themes.list",
        client,
        () => runWithGatewayRequestEnvelope("agent", client, preferences, options),
        options,
      ),
    () => expired!(),
  ]) {
    const background = burst();
    const result = Promise.resolve().then(run);
    await expect(result).rejects.toMatchObject({ code: "overloaded" });
    await background;
  }
  for (const role of [undefined, "cli-oneshot"] as const) {
    vi.mocked(databaseProcess.getDatabaseProcessRole).mockReturnValue(role);
    expect((await burst()).every((outcome) => outcome.status === "fulfilled")).toBe(true);
  }
});
