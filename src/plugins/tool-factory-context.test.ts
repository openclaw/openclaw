import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import {
  captureGatewayToolCallerAssertion,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { markPluginRegistryRetired } from "./registry-lifecycle.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRecord } from "./status.test-helpers.js";
import { createPluginToolFactoryContext } from "./tool-factory-context.js";
import { bindPluginToolCallbacks } from "./tool-factory-runtime.js";
import type { OpenClawPluginToolContext, OpenClawPluginToolFactory } from "./tool-types.js";

function register(factory: OpenClawPluginToolFactory | OpenClawPluginToolFactory<2>) {
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntimeMock(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: "probe", contracts: { tools: ["probe"] } });
  builder.registry.plugins.push(record);
  builder
    .createApi(record, { config: {}, registrationMode: "full" })
    .registerTool(factory, { name: "probe" });
  const entry = builder.registry.tools[0];
  if (!entry) {
    throw new Error("expected registered probe");
  }
  return { registry: builder.registry, entry };
}

function continuation(isCurrent: () => boolean) {
  return {
    isCurrent,
    assertCurrent() {
      if (!isCurrent()) {
        throw new Error("owner closed");
      }
    },
    senderId: "original-owner",
    channel: "discord",
    accountId: "original-account",
  };
}

describe("plugin tool declaration membership", () => {
  it("prepares detached, ordered, case-sensitive declarations once per record", () => {
    const builder = createTestPluginRegistry(createPluginRuntimeMock());
    const names = [" beta ", "Alpha", "beta", " ", "alpha"];
    const readNames = vi.fn(() => names);
    const record = createPluginRecord({
      id: "probe",
      contracts: {
        get tools() {
          return readNames();
        },
      },
    });
    builder.registry.plugins.push(record);
    const api = builder.createApi(record, { config: {}, registrationMode: "full" });
    expect(readNames).not.toHaveBeenCalled();

    api.registerTool(() => null, { names: [" beta ", "Alpha", "beta"] });
    names.splice(0, names.length, "new_tool");
    api.registerTool(() => null);
    api.registerTool(() => null, { name: "alpha" });
    api.registerTool(() => null, { names: ["new_tool", "BETA"] });

    expect(builder.registry.tools.map((entry) => entry.names)).toEqual([
      ["beta", "Alpha"],
      [],
      ["alpha"],
    ]);
    expect(record.toolNames).toEqual(["beta", "Alpha", "alpha"]);
    expect(builder.registry.tools.map((entry) => Array.from(entry.declaredNames ?? []))).toEqual([
      ["beta", "Alpha", "alpha"],
      ["beta", "Alpha", "alpha"],
      ["beta", "Alpha", "alpha"],
    ]);
    expect(builder.registry.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "plugin must declare contracts.tools for: new_tool, BETA",
    ]);
    expect(readNames).toHaveBeenCalledOnce();

    const replacement = createPluginRecord({ id: "probe", contracts: { tools: ["new_tool"] } });
    builder.registry.plugins[0] = replacement;
    builder
      .createApi(replacement, { config: {}, registrationMode: "full" })
      .registerTool(() => null, { name: "new_tool" });
    expect(builder.registry.tools.at(-1)?.names).toEqual(["new_tool"]);
    expect(Array.from(builder.registry.tools.at(-1)?.declaredNames ?? [])).toEqual(["new_tool"]);
    expect(readNames).toHaveBeenCalledOnce();
  });

  it.each([undefined, []])("retains empty declarations before factory validation (%j)", (names) => {
    const builder = createTestPluginRegistry(createPluginRuntimeMock());
    const readNames = vi.fn(() => names);
    const record = createPluginRecord({
      id: "empty",
      contracts: {
        get tools() {
          return readNames();
        },
      },
    });
    builder.registry.plugins.push(record);
    const api = builder.createApi(record, { config: {}, registrationMode: "full" });
    const readFactory = vi.fn(() => {
      throw new Error("factory must not be read");
    });
    for (let index = 0; index < 2; index += 1) {
      api.registerTool({
        contextVersion: 2,
        get create() {
          return readFactory();
        },
      });
    }
    expect(builder.registry.tools).toEqual([]);
    expect(builder.registry.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "plugin must declare contracts.tools before registering agent tools",
      "plugin must declare contracts.tools before registering agent tools",
    ]);
    expect(readFactory).not.toHaveBeenCalled();
    expect(readNames).toHaveBeenCalledOnce();
  });

  it("does not retain an incomplete declaration preparation after an accessor throws", () => {
    const builder = createTestPluginRegistry(createPluginRuntimeMock());
    const failure = new Error("declaration read failed");
    const readNames = vi
      .fn<() => string[]>()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockReturnValue(["probe"]);
    const record = createPluginRecord({
      id: "probe",
      contracts: {
        get tools() {
          return readNames();
        },
      },
    });
    builder.registry.plugins.push(record);
    const api = builder.createApi(record, { config: {}, registrationMode: "full" });
    expect(() => api.registerTool(() => null, { name: "probe" })).toThrow(failure);
    api.registerTool(() => null, { name: "probe" });
    expect(builder.registry.tools.map((entry) => entry.names)).toEqual([["probe"]]);
    expect(builder.registry.diagnostics).toEqual([]);
    expect(readNames).toHaveBeenCalledTimes(2);
  });
});

describe("versioned plugin tool authority", () => {
  it("offers callbacks only during the registered V2 tool execute, not from a factory or main run", async () => {
    let issue: OpenClawPluginToolContext<2>["issueAsyncCallback"] | undefined;
    const { entry, registry } = register({
      contextVersion: 2,
      create: (ctx) => {
        issue = ctx.issueAsyncCallback;
        return {
          name: "probe",
          label: "Probe",
          description: "Probe callback authority",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            await ctx.issueAsyncCallback!({ ttlMs: 60_000 });
            return { content: [{ type: "text" as const, text: "pending" }], details: {} };
          },
        };
      },
    });
    const ctx = createPluginToolFactoryContext({
      entry,
      registry,
      context: { agentId: "main", sessionKey: "agent:main:main", sessionId: "session" },
      runId: "run-main",
      assertInvocationCurrent: () => {},
    });
    const registered = entry.factory(ctx);
    expect(registered && !Array.isArray(registered)).toBe(true);
    await expect(issue!({ ttlMs: 60_000 })).rejects.toThrow("registered tool execution");
    const tool = bindPluginToolCallbacks(
      entry,
      registry,
      registered as Exclude<typeof registered, null | undefined | unknown[]>,
      ctx.assertInvocationCurrent,
    );
    await expect(tool.execute("call-1", {})).rejects.toThrow("admitted native child");
  });
  it("requires a final-effect assertion in the versioned context type", () => {
    expectTypeOf<OpenClawPluginToolContext<2>["assertInvocationCurrent"]>().toEqualTypeOf<
      () => void
    >();
    const { entry } = register({ contextVersion: 2, create: () => null });
    expect(entry.contextVersion).toBe(2);
    expect(() => entry.factory({ senderIsOwner: true })).toThrow(
      "require host invocation authority",
    );
  });

  it.each([false, true])(
    "does not promote legacy continuation factories, preserving direct owner=%s",
    (directOwner) => {
      const create = vi.fn(() => null);
      const { entry, registry } = register(create);
      const context = createPluginToolFactoryContext({
        entry,
        registry,
        context: { senderIsOwner: directOwner, requesterSenderId: "direct-sender" },
        ownerContinuation: continuation(() => true),
      });
      entry.factory(context);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ senderIsOwner: directOwner, requesterSenderId: "direct-sender" }),
      );
      expect(context.messageChannel).toBeUndefined();
      expect(context.agentAccountId).toBeUndefined();
    },
  );

  it("does not turn version opt-in or management-only context into owner authority", () => {
    const { entry, registry } = register({ contextVersion: 2, create: () => null });
    const context = createPluginToolFactoryContext({
      entry,
      registry,
      context: { senderIsOwner: false },
    });
    expect(context.senderIsOwner).toBe(false);
  });

  it("rejects an operational caller that has no live receipt authority", async () => {
    const { entry, registry } = register({ contextVersion: 2, create: () => null });
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:probe",
        operationalRunInstance: createOperationalRunInstanceRef("missing-receipt"),
      },
      async () => {
        const context = createPluginToolFactoryContext({
          entry,
          registry,
          context: {},
          assertInvocationCurrent: captureGatewayToolCallerAssertion(),
        });
        expect(() => context.assertInvocationCurrent()).toThrow(
          "caller authority is no longer active",
        );
      },
    );
  });

  it("allows metadata construction but rejects V2 effects without an admitted invocation", async () => {
    const effect = vi.fn();
    const { entry, registry } = register({
      contextVersion: 2,
      create: (ctx) => ({
        name: "probe",
        label: "Probe",
        description: "Metadata-only probe",
        parameters: { type: "object", properties: {} },
        async execute() {
          ctx.assertInvocationCurrent();
          effect();
          return { content: [], details: {} };
        },
      }),
    });
    const context = createPluginToolFactoryContext({ entry, registry, context: {} });
    const raw = entry.factory(context);
    if (!raw || Array.isArray(raw)) {
      throw new Error("expected metadata probe");
    }
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
      const { entry, registry } = register({
        contextVersion: 2,
        create: (context) => ({
          name: "probe",
          label: "Probe",
          description: "Synthetic final-effect probe",
          parameters: { type: "object", properties: {} },
          prepareArguments: (args: unknown) => args,
          async execute() {
            entered.resolve();
            await release.promise;
            context.assertInvocationCurrent();
            effect();
            return { content: [{ type: "text", text: "done" }], details: {} };
          },
        }),
      });
      const context = createPluginToolFactoryContext({
        entry,
        registry,
        context: { senderIsOwner: false },
        assertInvocationCurrent() {
          if (!runCurrent) {
            throw new Error("run closed");
          }
        },
        ownerContinuation: continuation(() => ownerCurrent),
      });
      expect(context).toMatchObject({
        senderIsOwner: true,
        requesterSenderId: "original-owner",
        messageChannel: "discord",
        agentAccountId: "original-account",
      });
      const raw = entry.factory(context);
      if (!raw || Array.isArray(raw)) {
        throw new Error("expected one probe");
      }
      const tool = bindPluginToolCallbacks(entry, registry, raw, context.assertInvocationCurrent);
      const work = tool.execute("probe", {});
      void work.catch(() => {});
      await entered.promise;
      if (mode === "owner-close") {
        ownerCurrent = false;
      }
      if (mode === "run-close") {
        runCurrent = false;
      }
      if (mode === "plugin-close") {
        markPluginRegistryRetired(registry);
      }
      release.resolve();
      if (mode === "allowed") {
        await expect(work).resolves.toMatchObject({ content: [{ text: "done" }] });
        expect(effect).toHaveBeenCalledOnce();
      } else {
        await expect(work).rejects.toThrow(/closed|no longer active/);
        expect(effect).not.toHaveBeenCalled();
        expect(() => tool.prepareArguments?.({})).toThrow(/closed|no longer active/);
      }
    },
  );
});
