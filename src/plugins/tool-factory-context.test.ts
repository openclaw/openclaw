import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import {
  captureGatewayToolCallerAssertion,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { markPluginRegistryRetired } from "./registry-lifecycle.js";
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

describe("versioned plugin tool authority", () => {
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
