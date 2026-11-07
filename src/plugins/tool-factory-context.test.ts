import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, expectTypeOf, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import {
  captureGatewayToolCallerAssertion,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { loadPluginInstanceForTest } from "../plugin-sdk/plugin-test-runtime.js";
import { withFetchPreconnect } from "../plugin-sdk/test-env.js";
import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { InvocationFrame } from "./plugin-instance-invocation.js";
import { markPluginRegistryRetired } from "./registry-lifecycle.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";
import { createPluginToolFactoryContext } from "./tool-factory-context.js";
import {
  bindPluginToolCallbacks,
  createPluginToolFactoryResolver,
} from "./tool-factory-runtime.js";
import type { OpenClawPluginToolContext, OpenClawPluginToolFactory } from "./tool-types.js";

const probe = (effect: () => void, assertCurrent?: () => void) => ({
  name: "probe",
  label: "Probe",
  description: "Synthetic probe",
  parameters: { type: "object", properties: {} },
  async execute() {
    assertCurrent?.();
    effect();
    return { content: [], details: {} };
  },
});

type FactoryContext = Parameters<typeof createPluginToolFactoryContext>[0];
type ContextOptions = Partial<
  Omit<FactoryContext, "entry" | "registry"> &
    Pick<FactoryContext["registry"], "memoryCapabilities">
>;
function toolRegistry(contracts: Parameters<typeof createPluginRecord>[0]["contracts"]) {
  const builder = createTestPluginRegistry(createPluginRuntimeMock());
  const record = createPluginRecord({ id: "probe", contracts });
  builder.registry.plugins.push(record);
  return {
    ...builder,
    record,
    api: builder.createApi(record, { config: {}, registrationMode: "full" }),
  };
}

function register(
  factory: OpenClawPluginToolFactory | OpenClawPluginToolFactory<2>,
  { memoryCapabilities = [], ...options }: ContextOptions = {},
) {
  const { registry, api } = toolRegistry({ tools: ["probe"] });
  api.registerTool(factory, { name: "probe" });
  const entry = registry.tools[0];
  assert(entry, "expected registered probe");
  registry.memoryCapabilities.push(...memoryCapabilities);
  const context = createPluginToolFactoryContext({ entry, registry, context: {}, ...options });
  return {
    registry,
    entry,
    context,
    tool: (bind = true) => {
      const raw = entry.factory(context);
      assert(raw && !Array.isArray(raw), "expected one probe");
      return bind
        ? bindPluginToolCallbacks(entry, registry, raw, context.assertInvocationCurrent)
        : raw;
    },
  };
}

const declarations = (readNames: () => string[] | undefined) =>
  toolRegistry({
    get tools() {
      return readNames();
    },
  });

const continuation = (isCurrent: () => boolean) => ({
  isCurrent,
  assertCurrent: () => assert(isCurrent(), "owner closed"),
  senderId: "original-owner",
  channel: "discord",
  accountId: "original-account",
});

it("enters the registered owner's scopes and retains the execution cancellation scope", async () => {
  const observed: string[] = [];
  const observe = () => {
    const scope = getPluginRuntimeGatewayRequestScope();
    expect(scope?.pluginId).toBe("probe");
    expect(scope?.pluginRegistry).toBe(registration.registry);
    observed.push(scope!.pluginId!);
  };
  const registration = register(() => {
    observe();
    return {
      ...probe(observe),
      prepareArguments(args: unknown) {
        observe();
        return args;
      },
    };
  });
  const frames = vi.spyOn(AsyncLocalStorage.prototype, "enterWith");
  try {
    const resolver = createPluginToolFactoryResolver((error) => assert.fail(error));
    const { resolved } = resolver.resolve(registration.entry, registration.context, ["probe"]);
    assert(resolved && !Array.isArray(resolved));
    const tool = bindPluginToolCallbacks(registration.entry, registration.registry, resolved);
    const args = {};
    expect(tool.prepareArguments?.(args)).toBe(args);
    await tool.execute("probe", args);
    expect(observed).toEqual(["probe", "probe", "probe"]);
    // Count invocation/recovery frames independently of the source-authority store.
    expect(frames.mock.calls.filter(([frame]) => frame instanceof InvocationFrame)).toHaveLength(4);
    expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
  } finally {
    frames.mockRestore();
  }
});

it("prepares detached, ordered, case-sensitive declarations once per record", () => {
  const names = [" beta ", "Alpha", "beta", " ", "alpha"];
  const declared = ["beta", "Alpha", "alpha"];
  const readNames = vi.fn(() => names);
  const { api, record, registry, createApi } = declarations(readNames);
  expect(readNames).not.toHaveBeenCalled();

  api.registerTool(() => null, { names: [" beta ", "Alpha", "beta"] });
  names.splice(0, names.length, "new_tool");
  api.registerTool(() => null);
  api.registerTool(() => null, { name: "alpha" });
  api.registerTool(() => null, { names: ["new_tool", "BETA"] });

  expect(registry.tools.map((entry) => entry.names)).toEqual([["beta", "Alpha"], [], ["alpha"]]);
  const registeredNames = registry.tools.map((entry) => [...(entry.declaredNames ?? [])]);
  expect(registeredNames).toEqual([declared, declared, declared]);
  expect(record.toolNames).toEqual(declared);
  expect(registry.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
    "plugin must declare contracts.tools for: new_tool, BETA",
  ]);
  expect(readNames).toHaveBeenCalledOnce();

  const replacement = createPluginRecord({ id: "probe", contracts: { tools: ["new_tool"] } });
  registry.plugins[0] = replacement;
  createApi(replacement, { config: {}, registrationMode: "full" }).registerTool(() => null, {
    name: "new_tool",
  });
  const latest = registry.tools.at(-1);
  expect([latest?.names, [...(latest?.declaredNames ?? [])]]).toEqual([["new_tool"], ["new_tool"]]);
  expect(readNames).toHaveBeenCalledOnce();
});

it.each([undefined, []])("retains empty declarations before factory validation (%j)", (names) => {
  const readNames = vi.fn(() => names);
  const { api, registry } = declarations(readNames);
  const readFactory = vi.fn(() => assert.fail("factory must not be read"));
  for (let index = 0; index < 2; index += 1) {
    api.registerTool({
      contextVersion: 2,
      get create() {
        return readFactory();
      },
    });
  }
  expect(registry.tools).toEqual([]);
  expect(registry.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
    "plugin must declare contracts.tools before registering agent tools",
    "plugin must declare contracts.tools before registering agent tools",
  ]);
  expect(readFactory).not.toHaveBeenCalled();
  expect(readNames).toHaveBeenCalledOnce();
});

it.each([false, true])("preserves V1 callbacks with host authority=%s", async (hostAuthority) => {
  const effect = vi.fn();
  let hostCurrent = true;
  const assertHostCurrent = vi.fn(() => assert(hostCurrent, "host invocation retired"));
  const registration = register((context) => probe(effect, context.assertInvocationCurrent), {
    context: {
      assertInvocationCurrent: () => assert.fail("untrusted input assertion"),
    },
    assertInvocationCurrent: hostAuthority ? assertHostCurrent : undefined,
  });
  const { context } = registration;
  expect(typeof context.assertInvocationCurrent).toBe(hostAuthority ? "function" : "undefined");
  const tool = registration.tool();

  await expect(tool.execute("ordinary", {})).resolves.toMatchObject({ details: {} });
  expect(assertHostCurrent.mock.calls.length > 0).toBe(hostAuthority);
  expect(effect).toHaveBeenCalledOnce();
  hostCurrent = false;
  if (!hostAuthority) {
    markPluginRegistryRetired(registration.registry);
  }
  await expect(tool.execute("retired", {})).rejects.toThrow(
    hostAuthority ? "host invocation retired" : "no longer active",
  );
  expect(effect).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "does not promote legacy continuation factories, preserving direct owner=%s",
  (directOwner) => {
    const create = vi.fn(() => null);
    const direct = { senderIsOwner: directOwner, requesterSenderId: "direct-sender" };
    const { entry, context } = register(create, {
      context: direct,
      ownerContinuation: continuation(() => true),
    });
    entry.factory(context);
    expect(create).toHaveBeenCalledWith(expect.objectContaining(direct));
    expect([context.messageChannel, context.agentAccountId]).toEqual([undefined, undefined]);
  },
);

it.each([
  { contextVersion: 1, hostAuthority: false },
  { contextVersion: 1, hostAuthority: true },
  { contextVersion: 2, hostAuthority: true },
] as const)("binds retained auth callbacks for %j", async ({ contextVersion, hostAuthority }) => {
  for (const callback of ["resolveAuthForProvider", "resolveApiKeyForProvider"] as const) {
    for (const closeAt of ["never", "before", "during"] as const) {
      const entered = createDeferred();
      const release = createDeferred();
      const selectedAuth = {
        apiKey: "synthetic-key",
        mode: "oauth" as const,
        profileId: "xai:synthetic",
      };
      const result = callback === "resolveAuthForProvider" ? selectedAuth : selectedAuth.apiKey;
      const lookup = vi.fn(async (providerId: string) => {
        expect(providerId).toBe("xai");
        entered.resolve();
        await release.promise;
        return selectedAuth;
      });
      let current = true;
      const { context, registry } = register(
        contextVersion === 2 ? { contextVersion: 2, create: () => null } : () => null,
        {
          context: {
            resolveAuthForProvider: lookup,
            resolveApiKeyForProvider: async (providerId) => (await lookup(providerId)).apiKey,
          },
          assertInvocationCurrent: hostAuthority
            ? () => assert(current, "host invocation retired")
            : undefined,
        },
      );
      const retire = () => {
        current = false;
        if (!hostAuthority) {
          markPluginRegistryRetired(registry);
        }
      };
      if (closeAt === "before") {
        retire();
      }
      const retained = context[callback]!;
      const work = retained("xai");
      if (closeAt !== "before") {
        await entered.promise;
        if (closeAt === "during") {
          retire();
        }
      }
      release.resolve();
      if (closeAt === "never") {
        await expect(work).resolves.toBe(result);
      } else {
        await expect(work).rejects.toThrow(/retired|no longer active/);
      }
      expect(lookup).toHaveBeenCalledTimes(closeAt === "before" ? 0 : 1);
      expect(context.assertInvocationCurrent === undefined).toBe(!hostAuthority);
    }
  }
});

it("rejects an operational caller that has no live receipt authority", async () => {
  await withGatewayToolCallerIdentity(
    {
      agentId: "main",
      sessionKey: "agent:main:probe",
      operationalRunInstance: createOperationalRunInstanceRef("missing-receipt"),
    },
    async () => {
      const { context } = register(
        { contextVersion: 2, create: () => null },
        {
          assertInvocationCurrent: captureGatewayToolCallerAssertion(),
        },
      );
      expect(() => context.assertInvocationCurrent?.()).toThrow(
        "caller authority is no longer active",
      );
    },
  );
});

it.each(["probe", "records"])("checks memory audience currency for slot owner=%s", (slotOwner) => {
  const checkAudience = vi.fn(() => assert.fail("memory audience is no longer current"));
  const { context } = register(() => null, {
    memoryCapabilities: [{ pluginId: slotOwner, capability: {}, memorySlotSelected: true }],
    context: { assertMemoryAudienceCurrent: checkAudience },
    assertInvocationCurrent: () => {},
  });
  expect(context.assertInvocationCurrent).toBeTypeOf("function");

  if (slotOwner === "probe") {
    expect(() => context.assertInvocationCurrent?.()).toThrow("no longer current");
  } else {
    expect(() => context.assertInvocationCurrent?.()).not.toThrow();
    expect(checkAudience).not.toHaveBeenCalled();
  }
});

it("allows metadata construction but rejects V2 effects without an admitted invocation", async () => {
  expectTypeOf<OpenClawPluginToolContext<2>["assertInvocationCurrent"]>().toEqualTypeOf<
    () => void
  >();
  const effect = vi.fn();
  const { entry, context, tool } = register(
    {
      contextVersion: 2,
      create: (ctx) => probe(effect, () => ctx.assertInvocationCurrent()),
    },
    { context: { senderIsOwner: false } },
  );
  expect(entry.contextVersion).toBe(2);
  expect(() => entry.factory({ senderIsOwner: true })).toThrow("require host invocation authority");
  expect(context.senderIsOwner).toBe(false);
  const raw = tool(false);
  expect(raw.name).toBe("probe");
  await expect(raw.execute("missing-run", {})).rejects.toThrow("outside an admitted run");
  expect(effect).not.toHaveBeenCalled();
});

it.each(["allowed", "owner-close", "run-close", "plugin-close"] as const)(
  "checks %s before the asynchronous tool's final effect and in retained preparers",
  async (mode) => {
    const entered = createDeferred();
    const release = createDeferred();
    const effect = vi.fn();
    let ownerCurrent = true;
    let runCurrent = true;
    const registration = register(
      {
        contextVersion: 2,
        create: (context) => ({
          ...probe(effect),
          async execute() {
            entered.resolve();
            await release.promise;
            context.assertInvocationCurrent();
            effect();
            return { content: [{ type: "text", text: "done" }], details: {} };
          },
          prepareArguments: (args: unknown) => args,
        }),
      },
      {
        context: { senderIsOwner: false },
        assertInvocationCurrent() {
          assert(runCurrent, "run closed");
        },
        ownerContinuation: continuation(() => ownerCurrent),
      },
    );
    const { context } = registration;
    expect(context).toMatchObject({
      senderIsOwner: true,
      requesterSenderId: "original-owner",
      messageChannel: "discord",
      agentAccountId: "original-account",
    });
    const tool = registration.tool();
    const work = tool.execute("probe", {});
    void work.catch(() => {});
    await entered.promise;
    ownerCurrent = mode !== "owner-close";
    runCurrent = mode !== "run-close";
    if (mode === "plugin-close") {
      markPluginRegistryRetired(registration.registry);
    }
    release.resolve();
    if (mode === "allowed") {
      await expect(work).resolves.toMatchObject({ content: [{ text: "done" }] });
    } else {
      await expect(work).rejects.toThrow(/closed|no longer active/);
      expect(() => tool.prepareArguments?.({})).toThrow(/closed|no longer active/);
    }
    expect(effect).toHaveBeenCalledTimes(mode === "allowed" ? 1 : 0);
  },
);

const subscriptionBase = "https://cli-chat-proxy.grok.com/v1";
const citation = "https://x.com/openclaw/status/1";
type Case = {
  label: string;
  name?: "x_search" | "code_execution";
  state?: "plugin retired" | "operation closed";
  mode?: "oauth" | "api-key";
  baseUrl?: string;
  providerEndpoint?: boolean;
};
afterEach(() => vi.unstubAllGlobals());

it.each<Case>([
  { label: "default subscription route" },
  { label: "explicit subscription route", baseUrl: subscriptionBase, providerEndpoint: true },
  { label: "provider subscription route", providerEndpoint: true },
  { label: "registered code execution", name: "code_execution" },
  { label: "plugin retired during auth", state: "plugin retired" },
  { label: "operation closed during auth", state: "operation closed" },
  { label: "public API key", baseUrl: "https://api.x.ai/v1", mode: "api-key" },
  { label: "custom API key", baseUrl: "https://search-proxy.example/v1", mode: "api-key" },
  { label: "explicit API key on subscription host", baseUrl: subscriptionBase, mode: "api-key" },
  { label: "custom OAuth proxy", baseUrl: "https://search-proxy.example/v1" },
])(
  "preserves registered xAI tool authority and routing: $label",
  async ({ name = "x_search", state, mode = "oauth", baseUrl, providerEndpoint }) => {
    const model = "grok-4.3";
    const config: OpenClawPluginToolContext["config"] = {
      plugins: {
        allow: ["xai"],
        entries: {
          xai: {
            enabled: true,
            config: {
              [name === "x_search" ? "xSearch" : "codeExecution"]:
                name === "x_search" ? { model, baseUrl, cacheTtlMinutes: 0 } : { model },
            },
          },
        },
      },
      ...(providerEndpoint
        ? {
            models: {
              providers: {
                xai: {
                  baseUrl: subscriptionBase,
                  api: "openai-responses",
                  auth: "oauth",
                  models: [],
                },
              },
            },
          }
        : {}),
    };
    const { registry, dispose } = await loadPluginInstanceForTest({ config, pluginId: "xai" });
    onTestFinished(dispose);
    const entry = registry.tools.find((tool) => tool.names.includes(name));
    assert(entry, "expected the actual registered xAI tool factory");
    const auth =
      createDeferred<
        Awaited<ReturnType<NonNullable<OpenClawPluginToolContext["resolveAuthForProvider"]>>>
      >();
    const resolving = createDeferred();
    let operationCurrent = true;
    const assertCurrent = () => assert(operationCurrent, "Owning operation is closed");
    const context = createPluginToolFactoryContext({
      entry,
      registry,
      assertInvocationCurrent: assertCurrent,
      context: {
        config,
        activeModel: { provider: "xai" },
        hasAuthForProvider: (provider) => provider === "xai",
        resolveAuthForProvider: async () => {
          resolving.resolve();
          return auth.promise;
        },
      },
    });
    const raw = entry.factory(context);
    assert(raw && !Array.isArray(raw), "expected one registered xAI tool");
    const tool = bindPluginToolCallbacks(entry, registry, raw, assertCurrent);
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`${baseUrl ?? subscriptionBase}/responses`);
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-subscription");
      const subscription = mode === "oauth" && (!baseUrl || baseUrl === subscriptionBase);
      for (const [header, value] of Object.entries({
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-version": "1.0.13",
        "x-grok-model-override": model,
      })) {
        expect(request.headers.get(header)).toBe(subscription ? value : null);
      }
      expect(await request.json()).toMatchObject({
        model,
        tools: [{ type: name === "x_search" ? "x_search" : "code_interpreter" }],
      });
      return Response.json({ output_text: "Synthetic cited answer", citations: [citation] });
    });
    vi.stubGlobal("fetch", withFetchPreconnect(transport));
    const pending = tool.execute("lifecycle-proof", {
      query: `subscription lifecycle: ${state}`,
      task: "fixture",
    });
    await resolving.promise;
    if (state === "plugin retired") {
      markPluginRegistryRetired(registry);
    }
    operationCurrent = state !== "operation closed";
    auth.resolve({ apiKey: "synthetic-subscription", mode });
    if (state) {
      await expect(pending).rejects.toThrow(/no longer active|operation is closed/);
      expect(transport).not.toHaveBeenCalled();
    } else {
      const result = await pending;
      expect(result.details).toMatchObject({
        content: expect.stringContaining("Synthetic cited answer"),
      });
      if (name === "x_search") {
        expect(result.details).toMatchObject({
          citations: [citation],
          externalContent: { source: "x_search", provider: "xai", untrusted: true, wrapped: true },
        });
      }
      expect(transport).toHaveBeenCalledOnce();
    }
  },
);
