// Registration-time contract for plugin node-event subscriptions: the
// allowlist is enforced, one owner per event, and handler shape is required.
import { expect, it } from "vitest";
import { createPluginRecord } from "./loader-records.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { NODE_EVENT_CONSUMER_EVENTS } from "./types.node-events.js";
import type { OpenClawPluginNodeEventSubscription } from "./types.node-events.js";

function builder() {
  const b = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "node-events-test",
    source: "test",
    origin: "global",
    enabled: true,
    configSchema: true,
  });
  b.registry.plugins.push(record);
  const api = b.createApi(record, { config: {} });
  return { b, record, api };
}

function subscription(
  overrides: Partial<OpenClawPluginNodeEventSubscription> = {},
): OpenClawPluginNodeEventSubscription {
  return { events: ["location.update"], handle: () => {}, ...overrides };
}

it("registers a valid subscription into the plugin registry with provenance", () => {
  const { b, record, api } = builder();
  api.registerNodeEventConsumer(subscription());
  expect(b.registry.nodeEventConsumers).toHaveLength(1);
  expect(b.registry.nodeEventConsumers[0]?.pluginId).toBe(record.id);
  expect(b.registry.nodeEventConsumers[0]?.subscription.events).toEqual(["location.update"]);
});

it("rejects events outside the gateway allowlist", () => {
  const { b, api } = builder();
  api.registerNodeEventConsumer(subscription({ events: ["voice.transcript"] as [string] }));
  expect(b.registry.nodeEventConsumers).toHaveLength(0);
});

it("rejects a second owner for an already consumed event", () => {
  const { b, record, api } = builder();
  api.registerNodeEventConsumer(subscription());
  const other = createPluginRecord({
    id: "node-events-second",
    source: "test",
    origin: "global",
    enabled: true,
    configSchema: true,
  });
  b.registry.plugins.push(other);
  const otherApi = b.createApi(other, { config: {} });
  otherApi.registerNodeEventConsumer(subscription());
  expect(b.registry.nodeEventConsumers).toHaveLength(1);
  expect(b.registry.nodeEventConsumers[0]?.pluginId).toBe(record.id);
});

it("rejects missing handlers and empty event lists", () => {
  const { b, api } = builder();
  api.registerNodeEventConsumer(subscription({ handle: undefined as unknown as () => void }));
  api.registerNodeEventConsumer(subscription({ events: [] as unknown as [string] }));
  expect(b.registry.nodeEventConsumers).toHaveLength(0);
});

it("gateway allowlist matches the schema-supported owner set", () => {
  expect(NODE_EVENT_CONSUMER_EVENTS).toEqual(["location.update"]);
});
