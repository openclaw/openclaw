import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  getSessionBindingService,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  isSessionBindingError,
  SessionBindingError,
  type SessionBindingAdapter,
  type SessionBindingRecord,
  __testing,
} from "./session-binding-service.js";

describe("session-binding-service", () => {
  beforeEach(() => {
    __testing.resetSessionBindingAdaptersForTests();
  });

  afterEach(() => {
    __testing.resetSessionBindingAdaptersForTests();
  });

  describe("registerSessionBindingAdapter", () => {
    it("registers an adapter for a channel and account", () => {
      const adapter: SessionBindingAdapter = {
        channel: "telegram",
        accountId: "test-account",
        listBySession: () => [],
        resolveByConversation: () => null,
      };
      registerSessionBindingAdapter(adapter);
      expect(__testing.getRegisteredAdapterKeys()).toContain("telegram:test-account");
    });

    it("normalizes channel to lowercase", () => {
      const adapter: SessionBindingAdapter = {
        channel: "TELEGRAM",
        accountId: "test-account",
        listBySession: () => [],
        resolveByConversation: () => null,
      };
      registerSessionBindingAdapter(adapter);
      expect(__testing.getRegisteredAdapterKeys()).toContain("telegram:test-account");
    });

    it("trims whitespace from channel and accountId", () => {
      const adapter: SessionBindingAdapter = {
        channel: "  telegram  ",
        accountId: "  test-account  ",
        listBySession: () => [],
        resolveByConversation: () => null,
      };
      registerSessionBindingAdapter(adapter);
      expect(__testing.getRegisteredAdapterKeys()).toContain("telegram:test-account");
    });
  });

  describe("unregisterSessionBindingAdapter", () => {
    it("removes a registered adapter", () => {
      const adapter: SessionBindingAdapter = {
        channel: "telegram",
        accountId: "test-account",
        listBySession: () => [],
        resolveByConversation: () => null,
      };
      registerSessionBindingAdapter(adapter);
      expect(__testing.getRegisteredAdapterKeys()).toContain("telegram:test-account");

      unregisterSessionBindingAdapter({
        channel: "telegram",
        accountId: "test-account",
        adapter,
      });
      expect(__testing.getRegisteredAdapterKeys()).not.toContain("telegram:test-account");
    });

    it("does nothing if no adapter is registered for the key", () => {
      unregisterSessionBindingAdapter({
        channel: "nonexistent",
        accountId: "no-account",
      });
      expect(__testing.getRegisteredAdapterKeys()).toHaveLength(0);
    });
  });

  describe("getCapabilities", () => {
    it("returns unavailable capabilities when no adapter is registered", () => {
      const service = getSessionBindingService();
      const caps = service.getCapabilities({ channel: "telegram", accountId: "test" });
      expect(caps.adapterAvailable).toBe(false);
      expect(caps.bindSupported).toBe(false);
      expect(caps.unbindSupported).toBe(false);
      expect(caps.placements).toHaveLength(0);
    });

    it("returns capabilities from registered adapter", () => {
      const adapter: SessionBindingAdapter = {
        channel: "telegram",
        accountId: "test-account",
        capabilities: {
          bindSupported: true,
          unbindSupported: true,
          placements: ["current", "child"],
        },
        listBySession: () => [],
        resolveByConversation: () => null,
      };
      registerSessionBindingAdapter(adapter);

      const service = getSessionBindingService();
      const caps = service.getCapabilities({ channel: "telegram", accountId: "test-account" });
      expect(caps.adapterAvailable).toBe(true);
      expect(caps.bindSupported).toBe(true);
      expect(caps.unbindSupported).toBe(true);
      expect(caps.placements).toEqual(expect.arrayContaining(["current", "child"]));
    });

    it("infers bindSupported from bind method presence", () => {
      const adapter: SessionBindingAdapter = {
        channel: "telegram",
        accountId: "test-account",
        bind: async () => null,
        listBySession: () => [],
        resolveByConversation: () => null,
      };
      registerSessionBindingAdapter(adapter);

      const service = getSessionBindingService();
      const caps = service.getCapabilities({ channel: "telegram", accountId: "test-account" });
      expect(caps.bindSupported).toBe(true);
    });
  });

  describe("listBySession", () => {
    it("returns empty array for empty session key", () => {
      const service = getSessionBindingService();
      expect(service.listBySession("")).toEqual([]);
    });

    it("returns bindings from all registered adapters", () => {
      const mockRecord: SessionBindingRecord = {
        bindingId: "binding-1",
        targetSessionKey: "session-1",
        targetKind: "session",
        conversation: {
          channel: "telegram",
          accountId: "test-account",
          conversationId: "conv-1",
        },
        status: "active",
        boundAt: Date.now(),
      };

      const adapter: SessionBindingAdapter = {
        channel: "telegram",
        accountId: "test-account",
        listBySession: (key) => (key === "session-1" ? [mockRecord] : []),
        resolveByConversation: () => null,
      };
      registerSessionBindingAdapter(adapter);

      const service = getSessionBindingService();
      const result = service.listBySession("session-1");
      expect(result).toHaveLength(1);
      expect(result[0].bindingId).toBe("binding-1");
    });

    it("deduplicates bindings by bindingId", () => {
      const mockRecord: SessionBindingRecord = {
        bindingId: "binding-1",
        targetSessionKey: "session-1",
        targetKind: "session",
        conversation: {
          channel: "telegram",
          accountId: "test-account",
          conversationId: "conv-1",
        },
        status: "active",
        boundAt: Date.now(),
      };

      const adapter: SessionBindingAdapter = {
        channel: "telegram",
        accountId: "test-account",
        listBySession: () => [mockRecord, mockRecord],
        resolveByConversation: () => null,
      };
      registerSessionBindingAdapter(adapter);

      const service = getSessionBindingService();
      const result = service.listBySession("session-1");
      expect(result).toHaveLength(1);
    });
  });

  describe("resolveByConversation", () => {
    it("returns null if conversation is missing channel or conversationId", () => {
      const service = getSessionBindingService();
      expect(
        service.resolveByConversation({
          channel: "",
          accountId: "test",
          conversationId: "conv-1",
        }),
      ).toBeNull();
      expect(
        service.resolveByConversation({
          channel: "telegram",
          accountId: "test",
          conversationId: "",
        }),
      ).toBeNull();
    });

    it("returns null if no adapter is registered", () => {
      const service = getSessionBindingService();
      expect(
        service.resolveByConversation({
          channel: "telegram",
          accountId: "test",
          conversationId: "conv-1",
        }),
      ).toBeNull();
    });

    it("returns record from registered adapter", () => {
      const mockRecord: SessionBindingRecord = {
        bindingId: "binding-1",
        targetSessionKey: "session-1",
        targetKind: "session",
        conversation: {
          channel: "telegram",
          accountId: "test-account",
          conversationId: "conv-1",
        },
        status: "active",
        boundAt: Date.now(),
      };

      const adapter: SessionBindingAdapter = {
        channel: "telegram",
        accountId: "test-account",
        listBySession: () => [],
        resolveByConversation: () => mockRecord,
      };
      registerSessionBindingAdapter(adapter);

      const service = getSessionBindingService();
      const result = service.resolveByConversation({
        channel: "telegram",
        accountId: "test-account",
        conversationId: "conv-1",
      });
      expect(result).toBe(mockRecord);
    });
  });

  describe("bind", () => {
    it("throws BINDING_ADAPTER_UNAVAILABLE if no adapter is registered", async () => {
      const service = getSessionBindingService();
      await expect(
        service.bind({
          targetSessionKey: "session-1",
          targetKind: "session",
          conversation: {
            channel: "telegram",
            accountId: "test",
            conversationId: "conv-1",
          },
        }),
      ).rejects.toThrow(SessionBindingError);
    });

    it("throws BINDING_CAPABILITY_UNSUPPORTED if adapter does not support bind", async () => {
      const adapter: SessionBindingAdapter = {
        channel: "telegram",
        accountId: "test-account",
        listBySession: () => [],
        resolveByConversation: () => null,
      };
      registerSessionBindingAdapter(adapter);

      const service = getSessionBindingService();
      await expect(
        service.bind({
          targetSessionKey: "session-1",
          targetKind: "session",
          conversation: {
            channel: "telegram",
            accountId: "test-account",
            conversationId: "conv-1",
          },
        }),
      ).rejects.toThrow(SessionBindingError);
    });

    it("throws BINDING_CREATE_FAILED if adapter.bind returns null", async () => {
      const adapter: SessionBindingAdapter = {
        channel: "telegram",
        accountId: "test-account",
        bind: async () => null,
        listBySession: () => [],
        resolveByConversation: () => null,
      };
      registerSessionBindingAdapter(adapter);

      const service = getSessionBindingService();
      await expect(
        service.bind({
          targetSessionKey: "session-1",
          targetKind: "session",
          conversation: {
            channel: "telegram",
            accountId: "test-account",
            conversationId: "conv-1",
          },
        }),
      ).rejects.toThrow(SessionBindingError);
    });
  });

  describe("touch", () => {
    it("does nothing if bindingId is empty", () => {
      const adapter: SessionBindingAdapter = {
        channel: "telegram",
        accountId: "test-account",
        listBySession: () => [],
        resolveByConversation: () => null,
        touch: () => {
          throw new Error("should not be called");
        },
      };
      registerSessionBindingAdapter(adapter);

      const service = getSessionBindingService();
      expect(() => service.touch("")).not.toThrow();
    });
  });

  describe("unbind", () => {
    it("returns empty array if no adapters support unbind", async () => {
      const adapter: SessionBindingAdapter = {
        channel: "telegram",
        accountId: "test-account",
        listBySession: () => [],
        resolveByConversation: () => null,
      };
      registerSessionBindingAdapter(adapter);

      const service = getSessionBindingService();
      const result = await service.unbind({
        bindingId: "binding-1",
        reason: "test",
      });
      expect(result).toEqual([]);
    });

    it("returns unbound records from adapters", async () => {
      const mockRecord: SessionBindingRecord = {
        bindingId: "binding-1",
        targetSessionKey: "session-1",
        targetKind: "session",
        conversation: {
          channel: "telegram",
          accountId: "test-account",
          conversationId: "conv-1",
        },
        status: "ended",
        boundAt: Date.now(),
      };

      const adapter: SessionBindingAdapter = {
        channel: "telegram",
        accountId: "test-account",
        listBySession: () => [],
        resolveByConversation: () => null,
        unbind: async () => [mockRecord],
      };
      registerSessionBindingAdapter(adapter);

      const service = getSessionBindingService();
      const result = await service.unbind({
        bindingId: "binding-1",
        reason: "test",
      });
      expect(result).toHaveLength(1);
      expect(result[0].bindingId).toBe("binding-1");
    });
  });
});

describe("SessionBindingError", () => {
  it("creates error with code and message", () => {
    const error = new SessionBindingError("BINDING_ADAPTER_UNAVAILABLE", "Adapter not found");
    expect(error.code).toBe("BINDING_ADAPTER_UNAVAILABLE");
    expect(error.message).toBe("Adapter not found");
    expect(error.name).toBe("SessionBindingError");
  });

  it("creates error with details", () => {
    const error = new SessionBindingError(
      "BINDING_CAPABILITY_UNSUPPORTED",
      "Placement not supported",
      { channel: "telegram", accountId: "test", placement: "child" },
    );
    expect(error.details?.channel).toBe("telegram");
    expect(error.details?.accountId).toBe("test");
    expect(error.details?.placement).toBe("child");
  });
});

describe("isSessionBindingError", () => {
  it("returns true for SessionBindingError instances", () => {
    const error = new SessionBindingError("BINDING_ADAPTER_UNAVAILABLE", "test");
    expect(isSessionBindingError(error)).toBe(true);
  });

  it("returns false for other errors", () => {
    const error = new Error("test");
    expect(isSessionBindingError(error)).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isSessionBindingError(null)).toBe(false);
    expect(isSessionBindingError(undefined)).toBe(false);
    expect(isSessionBindingError("error")).toBe(false);
  });
});
