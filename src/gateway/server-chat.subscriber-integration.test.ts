/**
 * Integration test: verify the real subscriber registries expose the exact API
 * that server.impl.ts calls. This catches naming mismatches between the registry
 * implementations (server-chat.ts) and their call sites (server.impl.ts) that
 * unit tests with mocks miss.
 *
 * No network, no gateway process — pure in-process verification.
 */
import { describe, expect, it } from "vitest";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
  createToolEventRecipientRegistry,
} from "./server-chat.js";

describe("subscriber registry integration (server.impl contract)", () => {
  describe("SessionEventSubscriberRegistry", () => {
    it("exposes subscribe/unsubscribe/getAll matching server.impl.ts call sites", () => {
      const registry = createSessionEventSubscriberRegistry();

      // server.impl.ts line 1104: subscribeSessionEvents: sessionEventSubscribers.subscribe
      expect(typeof registry.subscribe).toBe("function");
      // server.impl.ts line 1105: unsubscribeSessionEvents: sessionEventSubscribers.unsubscribe
      expect(typeof registry.unsubscribe).toBe("function");
      // server.impl.ts line 857/918/939/1112: sessionEventSubscribers.getAll()
      expect(typeof registry.getAll).toBe("function");

      // Functional round-trip
      registry.subscribe("conn-1");
      registry.subscribe("conn-2");
      expect(registry.getAll()).toContain("conn-1");
      expect(registry.getAll()).toContain("conn-2");

      registry.unsubscribe("conn-1");
      expect(registry.getAll()).not.toContain("conn-1");
      expect(registry.getAll()).toContain("conn-2");
    });
  });

  describe("SessionMessageSubscriberRegistry", () => {
    it("exposes subscribe/unsubscribe/unsubscribeAll/get matching server.impl.ts call sites", () => {
      const registry = createSessionMessageSubscriberRegistry();

      // server.impl.ts line 1106: subscribeSessionMessageEvents: sessionMessageSubscribers.subscribe
      expect(typeof registry.subscribe).toBe("function");
      // server.impl.ts line 1107: unsubscribeSessionMessageEvents: sessionMessageSubscribers.unsubscribe
      expect(typeof registry.unsubscribe).toBe("function");
      // server.impl.ts line 1110: sessionMessageSubscribers.unsubscribeAll(connId)
      expect(typeof registry.unsubscribeAll).toBe("function");
      // server.impl.ts line 860: sessionMessageSubscribers.get(sessionKey)
      expect(typeof registry.get).toBe("function");

      // Functional round-trip: subscribe conn to sessions
      registry.subscribe("conn-1", "session-a");
      registry.subscribe("conn-1", "session-b");
      registry.subscribe("conn-2", "session-a");

      expect(registry.get("session-a")).toContain("conn-1");
      expect(registry.get("session-a")).toContain("conn-2");
      expect(registry.get("session-b")).toContain("conn-1");

      // Unsubscribe single
      registry.unsubscribe("conn-2", "session-a");
      expect(registry.get("session-a")).not.toContain("conn-2");

      // UnsubscribeAll removes a conn from all sessions (WS disconnect cleanup)
      registry.unsubscribeAll("conn-1");
      expect(registry.get("session-a")).not.toContain("conn-1");
      expect(registry.get("session-b")).not.toContain("conn-1");

      // Empty set for unknown session
      expect(registry.get("nonexistent").size).toBe(0);
    });
  });

  describe("ToolEventRecipientRegistry", () => {
    it("exposes add/get/markFinal matching server-chat.ts handler call sites", () => {
      const registry = createToolEventRecipientRegistry();

      expect(typeof registry.add).toBe("function");
      expect(typeof registry.get).toBe("function");
      expect(typeof registry.markFinal).toBe("function");

      registry.add("run-1", "conn-1");
      registry.add("run-1", "conn-2");

      const recipients = registry.get("run-1");
      expect(recipients).toBeDefined();
      expect(recipients!.has("conn-1")).toBe(true);
      expect(recipients!.has("conn-2")).toBe(true);

      // Unknown run returns undefined
      expect(registry.get("nonexistent")).toBeUndefined();

      registry.markFinal("run-1");
      // After markFinal, get may still return the set (grace period) or undefined
      // — the contract just requires markFinal not to throw
    });
  });
});
