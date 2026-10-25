import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createCapturedPluginRegistration } from "../plugins/captured-registration.js";
import type { PluginCommandContext } from "../plugins/plugin-command.types.js";
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
const contract = defineFeatureContract({
  pluginId: "feature-fixture",
  operations: {
    inspect: {
      kind: "query",
      description: "Fixture value.",
      input: valueSchema,
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
  function register(
    options: Pick<DefineFeaturePluginOptions<typeof contract>, "setup" | "commands">,
  ) {
    const captured = createCapturedPluginRegistration({ id: contract.pluginId });
    const tools = vi.spyOn(captured.api, "registerTool");
    const commands = vi.spyOn(captured.api, "registerCommand").mockImplementation(() => {});
    const entry = defineFeaturePlugin({ ...definition, ...options });
    entry.register(captured.api);
    return {
      captured,
      entry,
      action: expectDefined(captured.sessionActions[0], "registered feature action"),
      command: () => expectDefined(commands.mock.calls[0]?.[0], "registered feature command"),
      createTool(context: Parameters<OpenClawPluginToolFactory>[0] = {}) {
        const factory = tools.mock.calls[0]?.[0];
        if (typeof factory !== "function") {
          throw new Error("Expected feature tool factory");
        }
        const tool = factory(context);
        if (!tool || Array.isArray(tool)) {
          throw new Error("Expected one feature tool");
        }
        return tool;
      },
    };
  }
  it("shares typed handlers without losing action, tool, or command invocation context", async () => {
    const contexts: FeatureInvocationContext[] = [];
    const { captured, entry, action, command, createTool } = register({
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
    expect(await command().handler(commandContext)).toEqual({ text: "command" });
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
    const { action } = register({ setup: () => ({ inspect: execute }) });
    const invoke = (value: number | string) =>
      action.handler({
        pluginId: contract.pluginId,
        actionId: "inspect",
        payload: { value },
      });
    expect(await invoke(4)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(execute).not.toHaveBeenCalled();
    expect(await invoke("valid")).toMatchObject({ ok: false, code: "INVALID_OUTPUT" });
  });

  it("propagates tool cancellation across awaited feature handlers", async () => {
    const { promise: pending, resolve: finish } = createDeferredCore();
    const { createTool } = register({
      setup: () => ({
        inspect: async (input) => {
          await pending;
          return input;
        },
      }),
    });
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
      { pluginId: "feature-alpha", actionId: "update", event: "updated" },
      { pluginId: "feature-beta", actionId: "publish", event: "published" },
    ];
    const operation = {
      kind: "action" as const,
      description: "Fixture event.",
      input: valueSchema,
      output: valueSchema,
    };
    const actions = fixtures.map(({ pluginId, actionId, event }) => {
      registerVirtualTestPlugin({
        registry,
        config,
        id: pluginId,
        name: pluginId,
        register: defineFeaturePlugin({
          ...definition,
          contract: defineFeatureContract({
            pluginId,
            operations: { [actionId]: operation },
            events: { [event]: valueSchema },
          }),
          setup: (_api, events) => ({
            [actionId]: (input) => {
              events.emit(event, input);
              return input;
            },
          }),
        }).register,
      });
      const { action } = expectDefined(
        registry.registry.sessionActions.find(
          (entry) => entry.pluginId === pluginId && entry.action.id === actionId,
        ),
        `registered ${pluginId} action`,
      );
      return {
        pluginId,
        invoke: () => action.handler({ pluginId, actionId, payload: { value: pluginId } }),
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
