import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { preparePluginToolExecutionCapabilities } from "../agents/plugin-tool-execution.js";
import * as catalogReader from "../gateway/server-methods/requester-model-catalog.js";
import { registerPluginCommandInRegistry } from "./command-registration.js";
import { createPluginRecord } from "./loader-records.js";
import type { PluginRequesterModels } from "./model-catalog.types.js";
import { createPluginCommandRuntime } from "./plugin-command-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { markPluginRegistryRetired } from "./registry-lifecycle.js";
import { createPluginRequesterModels } from "./requester-models.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { createRuntimeBase } from "./runtime/runtime-base.js";
import { createPluginToolFactoryContext } from "./tool-factory-context.js";
import type { OpenClawPluginToolContext } from "./tool-types.js";

const result = { revision: "fixture-revision", state: "prepared" as const, models: [] };
afterEach(() => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
});

function registry() {
  const value = createEmptyPluginRegistry();
  const record = createPluginRecord({
    id: "catalog-test",
    source: "/plugins/catalog-test/index.js",
    origin: "config",
    enabled: true,
    configSchema: true,
  });
  record.status = "loaded";
  value.plugins.push(record);
  setActivePluginRegistry(value);
  return value;
}

it("advertises a version without removing the released string-list capability contract", () => {
  const runtime = createRuntimeBase();
  expect(runtime.capabilities).toContain("requester-model-catalog-v1");
  expect(runtime.capabilities).toContain("sender-restricted-hidden-helpers-v1");
});

it("omits model authority when requester or exact session authority is missing and rejects forged authority", () => {
  const params = {
    config: {},
    agentId: "main",
    sessionKey: "agent:main:one",
    sessionId: "one",
    assertCurrent() {},
  };
  expect(createPluginRequesterModels(params)).toBeUndefined();
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "person",
    scopes: [],
    assertCurrent() {},
  });
  expect(
    createPluginRequesterModels({ ...params, sessionId: undefined, authority }),
  ).toBeUndefined();
  expect(() =>
    createPluginRequesterModels({
      ...params,
      authority: { profileId: "forged", scopes: [], assertCurrent() {} },
    }),
  ).toThrow("must be issued by the host");
});

it("exposes the tool reader only through v2 and fences retained readers by invocation and plugin lifetime", async () => {
  const value = registry();
  let current = true;
  const bindExecutionCapabilities = preparePluginToolExecutionCapabilities({
    config: {},
    agentId: "main",
    sessionKey: "agent:main:one",
    sessionId: "one",
    authority: createAdmittedRunOperatorAuthority({
      profileId: "person",
      scopes: [],
      assertCurrent() {},
    }),
  });
  const entry = {
    pluginId: "catalog-test",
    source: "runtime",
    factory: () => null,
    names: ["catalog"],
    optional: false,
  };
  const params = {
    registry: value,
    context: {},
    bindExecutionCapabilities,
    assertInvocationCurrent() {
      if (!current) {
        throw new Error("turn closed");
      }
    },
  };
  const legacy = createPluginToolFactoryContext({ ...params, entry });
  expect((legacy as OpenClawPluginToolContext<2>).runtimeContext?.models).toBeUndefined();
  const context = createPluginToolFactoryContext({
    ...params,
    entry: { ...entry, contextVersion: 2 },
  }) as OpenClawPluginToolContext<2>;
  const models = context.runtimeContext?.models;
  expect(models).toBeDefined();
  current = false;
  await expect(models?.list()).rejects.toThrow("turn closed");
  current = true;
  markPluginRegistryRetired(value);
  await expect(models?.list()).rejects.toThrow("no longer active");
});

it.each([
  { optedIn: false, authorized: true, present: true },
  { optedIn: true, authorized: false, present: true },
  { optedIn: true, authorized: true, present: false },
])(
  "leaves unsupported or unadmitted command readers undefined (%j)",
  async ({ optedIn, authorized, present }) => {
    const value = registry();
    let observed: PluginRequesterModels | undefined;
    let invoked = false;
    registerPluginCommandInRegistry(value, "catalog-test", {
      name: "catalog",
      description: "Catalog",
      requireAuth: false,
      ...(optedIn ? { runtimeCapabilities: ["models"] } : {}),
      handler(ctx) {
        invoked = true;
        observed = ctx.runtimeContext?.models;
        return {};
      },
    });
    const dispatch = createPluginCommandRuntime()
      .listNativeCandidates("webchat")[0]
      ?.prepareDispatch();
    if (dispatch?.kind !== "plugin") {
      throw new Error("Expected plugin dispatch");
    }
    await dispatch.execute({
      channel: "webchat",
      commandBody: "/catalog",
      config: {},
      agentId: "main",
      isAuthorizedSender: authorized,
      runtimeContext: present ? { createModels: () => ({ list: async () => result }) } : {},
    });
    expect(invoked).toBe(true);
    expect(observed).toBeUndefined();
  },
);

it("keeps command opt-in immutable and rejects reads after retirement or invocation completion, including in-flight results", async () => {
  const value = registry();
  const entered = createDeferred();
  const release = createDeferred();
  const requested: ("models" | "subagents")[] = ["models"];
  let retained: PluginRequesterModels | undefined;
  const list = vi
    .spyOn(catalogReader, "readRequesterModelCatalog")
    .mockImplementation(async (params) => {
      if (list.mock.calls.length === 1) {
        return result;
      }
      entered.resolve();
      await release.promise;
      params.assertCurrent();
      return result;
    });
  registerPluginCommandInRegistry(value, "catalog-test", {
    name: "catalog",
    description: "Catalog",
    runtimeCapabilities: requested,
    async handler(ctx) {
      retained = ctx.runtimeContext?.models;
      expect(await retained?.list()).toEqual(result);
      await retained?.list();
      return { text: "published" };
    },
  });
  requested.length = 0;
  const dispatch = createPluginCommandRuntime()
    .listNativeCandidates("webchat")[0]
    ?.prepareDispatch();
  if (dispatch?.kind !== "plugin") {
    throw new Error("Expected plugin dispatch");
  }
  const executing = dispatch.execute({
    channel: "webchat",
    commandBody: "/catalog",
    config: {},
    agentId: "main",
    isAuthorizedSender: true,
    runtimeContext: {
      createModels: ({ signal, assertCurrent }) =>
        createPluginRequesterModels({
          config: {},
          agentId: "main",
          sessionKey: "agent:main:one",
          sessionId: "one",
          authority: createAdmittedRunOperatorAuthority({
            profileId: "person",
            scopes: [],
            assertCurrent() {},
          }),
          signal,
          assertCurrent,
        }),
    },
  });
  await awaitGateBeforeSettlement(
    entered.promise,
    executing,
    "Command did not reach the model reader",
  );
  markPluginRegistryRetired(value);
  release.resolve();
  await expect(executing).resolves.toEqual({ text: "⚠️ Command failed. Please try again later." });
  expect(list).toHaveBeenCalledTimes(2);
  await expect(retained?.list()).rejects.toBe("command invocation closed");
  expect(list).toHaveBeenCalledTimes(2);
});
