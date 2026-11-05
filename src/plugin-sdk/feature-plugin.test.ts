import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createCapturedPluginRegistration } from "../plugins/captured-registration.js";
import type {
  PluginCommandContext,
  OpenClawPluginCommandDefinition,
} from "../plugins/plugin-command.types.js";
import { startPluginServices } from "../plugins/services.test-support.js";
import type { OpenClawPluginToolFactory } from "../plugins/tool-types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { defineFeatureContract } from "./feature-contract.js";
import {
  defineFeaturePlugin,
  type DefineFeaturePluginOptions,
  type FeatureInvocationContext,
} from "./feature-plugin.js";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "./test-helpers/contracts-testkit.js";
import { getToolPluginMetadata } from "./tool-plugin.js";

const valueSchema = Type.Object({ value: Type.String() }, { additionalProperties: false });
const baseOperation = {
  description: "Fixture value.",
  input: valueSchema,
  output: valueSchema,
};
const contract = defineFeatureContract({
  pluginId: "feature-fixture",
  operations: {
    inspect: {
      kind: "query",
      ...baseOperation,
      output: Type.Object(
        { value: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      tool: { name: "fixture_inspect" },
    },
  },
  events: { changed: Type.Object({ value: Type.String() }) },
});
const definition = { contract, name: "Feature fixture", description: "Fixture operations." };

describe("typed feature plugins", () => {
  let captured: ReturnType<typeof createCapturedPluginRegistration>;
  let factory: OpenClawPluginToolFactory | undefined;
  let command: OpenClawPluginCommandDefinition | undefined;
  beforeEach(() => {
    captured = createCapturedPluginRegistration({ id: contract.pluginId });
    factory = undefined;
    command = undefined;
    captured.api.registerTool = (tool) => {
      if (typeof tool === "function") {
        factory = tool;
      }
    };
    captured.api.registerCommand = (value) => {
      command = value;
    };
  });
  function register(setup: DefineFeaturePluginOptions<typeof contract>["setup"]) {
    defineFeaturePlugin({ ...definition, setup }).register(captured.api);
    return expectDefined(captured.sessionActions[0], "registered feature action");
  }
  function createTool(context: Parameters<OpenClawPluginToolFactory>[0] = {}) {
    const tool = expectDefined(factory, "registered feature tool factory")(context);
    if (!tool || Array.isArray(tool)) {
      throw new Error("Expected one feature tool");
    }
    return tool;
  }
  it("shares typed handlers without losing action, tool, or command invocation context", async () => {
    const contexts: FeatureInvocationContext[] = [];
    const entry = defineFeaturePlugin({
      ...definition,
      setup: () => ({
        inspect(input, context) {
          expectTypeOf(input.value).toEqualTypeOf<string>();
          contexts.push(context);
          return { value: input.value };
        },
      }),
      commands: {
        inspect: {
          name: "fixture-inspect",
          parse: (context) => ({ value: context.args ?? "" }),
          format: (output) => ({ text: output.value }),
        },
      },
    });
    expect(getToolPluginMetadata(entry)?.tools).toMatchObject([
      { name: "fixture_inspect", outputSchema: contract.operations.inspect.output },
    ]);
    entry.register(captured.api);
    const action = expectDefined(captured.sessionActions[0], "registered feature action");
    const actionContext = {
      pluginId: contract.pluginId,
      actionId: "inspect",
      payload: { value: "action" },
      client: { connId: "browser", scopes: ["operator.read"] },
    };
    expect(await action.handler(actionContext)).toEqual({ ok: true, result: { value: "action" } });
    expect(action.requiredScopes).toEqual(["operator.read"]);

    const toolContext = { sessionKey: "agent:fixture:task", agentId: "fixture", sandboxed: true };
    const tool = createTool(toolContext);
    const controller = new AbortController();
    const onUpdate = vi.fn();
    expect(
      (await tool.execute("call-42", { value: "tool" }, controller.signal, onUpdate)).details,
    ).toEqual({ value: "tool" });
    const commandContext = {
      args: "command",
      channel: "chat",
      isAuthorizedSender: true,
      sessionKey: "agent:fixture:chat",
    } as PluginCommandContext;
    expect(
      await expectDefined(command, "registered feature command").handler(commandContext),
    ).toEqual({ text: "command" });
    expect(contexts).toEqual([
      { source: "session-action", action: actionContext, api: captured.api },
      {
        source: "tool",
        tool: toolContext,
        toolCallId: "call-42",
        signal: controller.signal,
        onUpdate,
        api: captured.api,
      },
      { source: "command", command: commandContext, api: captured.api },
    ]);
    expect(contexts[1]?.source === "tool" && contexts[1].tool).toBe(toolContext);
  });

  it("rejects invalid inputs before execution and invalid outputs before returning success", async () => {
    const execute = vi.fn(() => ({ value: "" }));
    const action = register(() => ({ inspect: execute }));
    const invoke = (value: number | string) =>
      action.handler({
        pluginId: contract.pluginId,
        actionId: "inspect",
        payload: { value },
      });
    expect(await invoke(4)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(execute).not.toHaveBeenCalled();
    expect(await invoke("valid")).toMatchObject({ ok: false, code: "INVALID_OUTPUT" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("propagates tool cancellation across awaited feature handlers", async () => {
    const { promise: pending, resolve: finish } = createDeferredCore();
    register(() => ({
      inspect: async (input) => {
        await pending;
        return input;
      },
    }));
    const tool = createTool();
    const controller = new AbortController();
    const result = tool.execute("cancelled-call", { value: "pending" }, controller.signal);
    controller.abort(new Error("tool cancelled"));
    finish();
    await expect(result).rejects.toThrow("tool cancelled");
  });

  it("starts and retires independent event emitters for multiple feature plugins", async () => {
    const { config, registry } = createPluginRegistryFixture();
    const fixtures = [
      { pluginId: "feature-alpha", operation: "update", event: "updated" },
      { pluginId: "feature-beta", operation: "publish", event: "published" },
    ];
    for (const { pluginId, operation: actionId, event } of fixtures) {
      const pluginContract = defineFeatureContract({
        pluginId,
        operations: {
          [actionId]: { ...baseOperation, kind: "action" },
        },
        events: { [event]: valueSchema },
      });
      const entry = defineFeaturePlugin({
        contract: pluginContract,
        name: pluginId,
        description: "Fixture event operations.",
        setup: (_api, events) => ({
          [actionId]: (input) => {
            events.emit(event, input);
            return input;
          },
        }),
      });
      registerVirtualTestPlugin({
        registry,
        config,
        id: pluginId,
        name: pluginId,
        register: entry.register,
      });
    }
    const actions = fixtures.map(({ pluginId, operation }) => {
      const { action } = expectDefined(
        registry.registry.sessionActions.find(
          (entry) => entry.pluginId === pluginId && entry.action.id === operation,
        ),
        `registered ${pluginId} action`,
      );
      return {
        pluginId,
        invoke: () =>
          action.handler({ pluginId, actionId: operation, payload: { value: pluginId } }),
      };
    });
    for (const { invoke } of actions) {
      await expect(invoke()).rejects.toThrow("emitter is unavailable");
    }

    const broadcastPluginEvent = vi.fn();
    const services = await startPluginServices({
      registry: registry.registry,
      config,
      broadcastPluginEvent,
    });
    try {
      for (const { pluginId, invoke } of actions) {
        await expect(invoke()).resolves.toEqual({ ok: true, result: { value: pluginId } });
      }
      expect(registry.registry.diagnostics).toEqual([]);
      expect(broadcastPluginEvent.mock.calls).toEqual(
        fixtures.map(({ pluginId, event }) => [
          `plugin.${pluginId}.${event}`,
          { value: pluginId },
          "operator.read",
        ]),
      );
    } finally {
      await services.stop();
    }
    for (const { invoke } of actions) {
      await expect(invoke()).rejects.toThrow();
    }
    expect(broadcastPluginEvent).toHaveBeenCalledTimes(fixtures.length);
  });
});
