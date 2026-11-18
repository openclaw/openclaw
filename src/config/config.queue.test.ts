import { describe, expect, it } from "vitest";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { buildConfigSchemaCore } from "./schema.js";
import { lookupConfigSchema } from "./schema.lookup.js";
import { validateConfigObject, validateConfigObjectWithPlugins } from "./validation.js";

describe("queue configuration", () => {
  it.each([
    { byChannel: { x: "invalid" } },
    { debounceMsByChannel: { x: -1 } },
    { debounceMsByChannel: { x: 1.5 } },
    { allowCollaborativeSteering: "false" },
    { allowCollaborativeSteering: null },
    { collaborativeSteeringFallback: "allow" },
  ])("rejects invalid plugin-channel queue values: %j", (queue) => {
    expect(validateConfigObject({ messages: { queue } }).ok).toBe(false);
  });

  it.each([false, true])("preserves explicit collaborative steering %s", (value) => {
    const queue = { allowCollaborativeSteering: value };
    const result = validateConfigObject({ messages: { queue } });
    expect(result).toMatchObject({ ok: true, config: { messages: { queue } } });
  });

  it.each(["queue", "reject"] as const)("preserves collaborative fallback %s", (value) => {
    const queue = { collaborativeSteeringFallback: value };
    expect(validateConfigObject({ messages: { queue } })).toMatchObject({
      ok: true,
      config: { messages: { queue } },
    });
  });

  it("validates queue channel keys against plugin metadata without rejecting unknown keys", () => {
    const queue = {
      byChannel: { chat: "followup", webchat: "collect", telegarm: "followup" },
      debounceMsByChannel: { chat: 250, webchat: 0, telegarm: 500 },
    };
    const result = validateConfigObjectWithPlugins(
      {
        agents: { entries: { openclaw: {} } },
        messages: { queue },
        plugins: { enabled: false },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: {
            diagnostics: [],
            plugins: [
              createPluginManifestRecordFixture({
                id: "chat-plugin",
                channels: ["chat"],
                origin: "config",
              }),
            ],
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.messages?.queue).toEqual({ ...queue, allowCollaborativeSteering: true });
    expect(result.warnings.filter(({ path }) => path.startsWith("messages.queue."))).toEqual([
      {
        path: "messages.queue.byChannel.telegarm",
        message:
          "unknown channel id: telegarm (install its channel plugin or correct this setting)",
      },
      {
        path: "messages.queue.debounceMsByChannel.telegarm",
        message:
          "unknown channel id: telegarm (install its channel plugin or correct this setting)",
      },
    ]);
  });

  it("looks up queue settings for plugin channel IDs", () => {
    const schema = buildConfigSchemaCore();
    const mode = lookupConfigSchema(schema, "messages.queue.byChannel.x");
    expect(mode?.path).toBe("messages.queue.byChannel.x");
    expect(mode?.schema).toMatchObject({
      anyOf: [
        { const: "steer" },
        { const: "followup" },
        { const: "collect" },
        { const: "interrupt" },
      ],
    });
    const debounce = lookupConfigSchema(schema, "messages.queue.debounceMsByChannel.x");
    expect(debounce?.schema).toMatchObject({ type: "integer", minimum: 0 });
    const steering = lookupConfigSchema(schema, "messages.queue.allowCollaborativeSteering");
    expect(steering?.schema).toMatchObject({ type: "boolean" });
  });
});
