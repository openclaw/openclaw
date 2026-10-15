import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { registerAgentHarness } from "../agents/harness/registry.js";
import type { SessionEntry } from "../config/sessions.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import type { GatewaySessionRow } from "./session-utils.types.js";
import { agentDiscoveryMock, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
let originalRegistry: ReturnType<typeof getActivePluginRegistry>;
beforeEach(() => {
  originalRegistry = getActivePluginRegistry();
  setActivePluginRegistry(createEmptyPluginRegistry());
  registerAgentHarness({
    id: "repository-device",
    label: "Repository device",
    autoSelection: { providerIds: ["repository-provider"] },
    supports: () => ({ supported: true }),
    cloudPlacement: {
      mode: "remote-exec",
      devicePlacement: {
        requiredNodeCommands: ["runtime.repository.v1"],
        consumesWorkerSlot: false,
      },
    },
    runAttempt: async () => {
      throw new Error("selection must not execute the runtime");
    },
  });
});
afterEach(() => {
  if (originalRegistry) {
    setActivePluginRegistry(originalRegistry);
  }
});

test("sessions.dispatch admits the runtime offered after a repository child's parent changes model", async () => {
  await createSessionStoreDir();
  const configModule = await getGatewayConfigModule();
  const base = configModule.getRuntimeConfig();
  configModule.setRuntimeConfigSnapshot({
    ...base,
    agents: {
      ...base.agents,
      defaults: { ...base.agents?.defaults, model: { primary: "fixture-cli/local" } },
    },
    cloudWorkers: { profiles: { test: { provider: "fake" } } },
  });
  const registry = expectDefined(getActivePluginRegistry(), "test registry");
  registry.cliBackends.push({
    pluginId: "fixture-cli",
    pluginName: "Fixture CLI",
    backend: { id: "fixture-cli", config: { command: "not-executed" } },
    source: "test",
  });
  agentDiscoveryMock.models = [
    { provider: "parent-api", id: "worker-model" },
    { provider: "fixture-cli", id: "local" },
  ];
  const client = createOperatorWsClient();
  const parentKey = "agent:main:main";
  const childKey = "agent:main:repository-child";
  expect((await directSessionReq("sessions.create", { key: parentKey }, { client })).ok).toBe(true);
  const created = await directSessionReq<{ entry: SessionEntry }>(
    "sessions.create",
    {
      key: childKey,
      parentSessionKey: parentKey,
      repository: { url: "https://github.com/openclaw/openclaw" },
    },
    { client },
  );
  expect(created.ok).toBe(true);
  expect(created.payload?.entry.modelOverride).toBeUndefined();
  const patched = await directSessionReq(
    "sessions.patch",
    { key: parentKey, model: "parent-api/worker-model" },
    { client },
  );
  expect(patched.error).toBeUndefined();
  expect(patched.ok).toBe(true);
  const listed = await directSessionReq<{ sessions: GatewaySessionRow[] }>(
    "sessions.list",
    {},
    { client },
  );
  const child = listed.payload?.sessions.find((row) => row.key === childKey);
  expect(child).toMatchObject({
    modelProvider: "parent-api",
    model: "worker-model",
    modelOverrideSource: "inherited",
    agentRuntime: { id: "openclaw", cloudPlacementSupported: true },
  });
  const dispatch = vi
    .fn<NonNullable<GatewayRequestContext["workerPlacementDispatchService"]>["dispatch"]>()
    .mockRejectedValue(new Error("admitted to placement service"));
  const result = await directSessionReq(
    "sessions.dispatch",
    { key: childKey, profileId: "test" },
    {
      client,
      context: {
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
        workerEnvironmentService: { supportsExecutionMode: () => true },
      },
    },
  );
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionKey: childKey,
      executionMode: "worker-turn",
      profileId: "test",
    }),
    expect.any(Function),
    undefined,
    undefined,
  );
  expect(result.error?.message).toBe("admitted to placement service");
});

test("sessions.list searches the displayed automatic runtime before applying pagination", async () => {
  await createSessionStoreDir();
  const entries: Record<string, SessionEntry> = {};
  for (let index = 0; index < 3; index++) {
    entries[`agent:main:selection-${index}`] = {
      sessionId: `selection-${index}`,
      updatedAt: index + 1,
      providerOverride: "repository-provider",
      modelOverride: "repository-model",
    };
  }
  entries["agent:main:unrelated"] = {
    sessionId: "unrelated",
    updatedAt: 10,
    providerOverride: "anthropic",
    modelOverride: "other",
  };
  await writeSessionStore({ entries });
  const first = await directSessionReq<{
    sessions: GatewaySessionRow[];
    totalCount: number;
    nextOffset: number;
  }>("sessions.list", { search: "repository-device", limit: 1 });
  expect(first.ok).toBe(true);
  expect(first.payload?.totalCount).toBe(3);
  expect(first.payload?.sessions.map((row) => row.key)).toEqual(["agent:main:selection-2"]);
  const second = await directSessionReq<{ sessions: GatewaySessionRow[]; totalCount: number }>(
    "sessions.list",
    { search: "repository-device", limit: 1, offset: first.payload?.nextOffset },
  );
  expect(second.payload?.totalCount).toBe(3);
  expect(second.payload?.sessions.map((row) => row.key)).toEqual(["agent:main:selection-1"]);
  expect(second.payload?.sessions[0]?.agentRuntime?.id).toBe("repository-device");
});
