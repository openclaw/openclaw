import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock NATS module
const mockPublish = vi.fn().mockResolvedValue({ seq: 1 });
const mockStreamInfo = vi.fn();
const mockStreamAdd = vi.fn().mockResolvedValue({});
const mockDrain = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockIsClosed = vi.fn().mockReturnValue(false);
const mockJetstream = vi.fn().mockReturnValue({ publish: mockPublish });
const mockJetstreamManager = vi.fn().mockResolvedValue({
  streams: { info: mockStreamInfo, add: mockStreamAdd },
});

// Async iterator that never yields (for nc.status())
const emptyAsyncIter = {
  [Symbol.asyncIterator]: () => ({
    next: () => new Promise<{ done: true; value: undefined }>(() => {}),
  }),
};

const mockConnection = {
  jetstream: mockJetstream,
  jetstreamManager: mockJetstreamManager,
  isClosed: mockIsClosed,
  drain: mockDrain,
  close: mockClose,
  status: vi.fn().mockReturnValue(emptyAsyncIter),
};

vi.mock("nats", () => ({
  connect: vi.fn().mockResolvedValue(mockConnection),
  StringCodec: vi.fn(() => ({
    encode: (s: string) => Buffer.from(s),
    decode: (b: Buffer) => b.toString(),
  })),
  RetentionPolicy: { Limits: "limits" },
  StorageType: { File: "file" },
  Events: { Reconnect: "reconnect", Disconnect: "disconnect" },
}));

// Mock agent-events to capture the listener
let capturedListener: ((evt: unknown) => void) | null = null;
vi.mock("./agent-events.js", () => ({
  onAgentEvent: vi.fn((cb: (evt: unknown) => void) => {
    capturedListener = cb;
    return () => {
      capturedListener = null;
    };
  }),
}));

const DEFAULT_CONFIG = {
  enabled: true,
  natsUrl: "nats://localhost:4222",
  streamName: "test-events",
  subjectPrefix: "test.events",
};

describe("Event Store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedListener = null;
    mockStreamInfo.mockRejectedValue(new Error("not found"));
    mockIsClosed.mockReturnValue(false);
    mockPublish.mockResolvedValue({ seq: 1 });
    mockDrain.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const { resetForTest } = await import("./event-store.js");
    resetForTest();
  });

  // ───────────────────────────────────────────────────────────────────────
  // initEventStore
  // ───────────────────────────────────────────────────────────────────────

  describe("initEventStore", () => {
    it("should not connect when disabled", async () => {
      const { connect } = await import("nats");
      const { initEventStore } = await import("./event-store.js");

      await initEventStore({ ...DEFAULT_CONFIG, enabled: false });

      expect(connect).not.toHaveBeenCalled();
    });

    it("should connect to NATS and create stream when enabled", async () => {
      const { connect } = await import("nats");
      const { initEventStore } = await import("./event-store.js");

      await initEventStore(DEFAULT_CONFIG);

      expect(connect).toHaveBeenCalledWith(
        expect.objectContaining({
          servers: "localhost:4222",
          reconnect: true,
          timeout: 5_000,
        }),
      );
      expect(mockStreamAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "test-events",
          subjects: ["test.events.>"],
        }),
      );
    });

    it("should not create stream if it already exists", async () => {
      mockStreamInfo.mockResolvedValue({ config: {} });
      const { initEventStore } = await import("./event-store.js");

      await initEventStore(DEFAULT_CONFIG);

      expect(mockStreamAdd).not.toHaveBeenCalled();
    });

    it("should parse credentials from natsUrl without logging them", async () => {
      const { connect } = await import("nats");
      const { initEventStore } = await import("./event-store.js");

      await initEventStore({
        ...DEFAULT_CONFIG,
        natsUrl: "nats://myuser:secret@nats.example.com:4222",
      });

      expect(connect).toHaveBeenCalledWith(
        expect.objectContaining({
          servers: "nats.example.com:4222",
          user: "myuser",
          pass: "secret",
        }),
      );
    });

    it("should not initialize twice", async () => {
      const { connect } = await import("nats");
      const { initEventStore } = await import("./event-store.js");

      await initEventStore(DEFAULT_CONFIG);
      await initEventStore(DEFAULT_CONFIG);

      expect(connect).toHaveBeenCalledTimes(1);
    });

    it("should forward retention config to stream creation", async () => {
      const { initEventStore } = await import("./event-store.js");

      await initEventStore({
        ...DEFAULT_CONFIG,
        retention: { maxMessages: 500_000, maxBytes: 1_073_741_824, maxAgeHours: 168 },
      });

      expect(mockStreamAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          max_msgs: 500_000,
          max_bytes: 1_073_741_824,
          max_age: 168 * 3_600_000_000_000,
        }),
      );
    });

    it("should handle NATS connect failure gracefully", async () => {
      const { connect } = await import("nats");
      (connect as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Connection refused"));
      const { initEventStore, isEventStoreConnected } = await import("./event-store.js");

      // Should not throw
      await initEventStore(DEFAULT_CONFIG);

      expect(isEventStoreConnected()).toBe(false);
    });

    it("should handle stream creation failure gracefully", async () => {
      mockStreamInfo.mockRejectedValue(new Error("not found"));
      mockStreamAdd.mockRejectedValueOnce(new Error("stream create failed"));
      const { connect } = await import("nats");
      // connect succeeds but ensureStream throws — whole init should fail gracefully
      (connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockConnection);
      const { initEventStore, isEventStoreConnected } = await import("./event-store.js");

      await initEventStore(DEFAULT_CONFIG);

      // Init should have caught the error
      expect(isEventStoreConnected()).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Event publishing
  // ───────────────────────────────────────────────────────────────────────

  describe("event publishing", () => {
    it("should publish user messages as msg.in", async () => {
      const { initEventStore } = await import("./event-store.js");
      await initEventStore(DEFAULT_CONFIG);

      expect(capturedListener).not.toBeNull();
      capturedListener!({
        ts: 1700000000000,
        sessionKey: "main",
        stream: "user",
        data: { text: "Hello" },
        seq: 1,
        runId: "run-1",
      });

      await vi.waitFor(() => expect(mockPublish).toHaveBeenCalled());

      const [subject, data] = mockPublish.mock.calls[0];
      expect(subject).toBe("test.events.main.msg_in");
      const parsed = JSON.parse(data.toString());
      expect(parsed.type).toBe("msg.in");
      expect(parsed.agent).toBe("main");
    });

    it("should publish tool results correctly", async () => {
      const { initEventStore } = await import("./event-store.js");
      await initEventStore(DEFAULT_CONFIG);

      capturedListener!({
        ts: 1700000000000,
        sessionKey: "viola:session:123",
        stream: "tool",
        data: { result: "done" },
        seq: 2,
        runId: "run-2",
      });

      await vi.waitFor(() => expect(mockPublish).toHaveBeenCalled());

      const [subject, data] = mockPublish.mock.calls[0];
      expect(subject).toBe("test.events.viola.tool_result");
      const parsed = JSON.parse(data.toString());
      expect(parsed.type).toBe("tool.result");
      expect(parsed.agent).toBe("viola");
    });

    it("should publish tool calls (without result/output in data)", async () => {
      const { initEventStore } = await import("./event-store.js");
      await initEventStore(DEFAULT_CONFIG);

      capturedListener!({
        ts: 1700000000000,
        sessionKey: "main",
        stream: "tool",
        data: { name: "web_search", args: { query: "test" } },
        seq: 4,
        runId: "run-4",
      });

      await vi.waitFor(() => expect(mockPublish).toHaveBeenCalled());

      const parsed = JSON.parse(mockPublish.mock.calls[0][1].toString());
      expect(parsed.type).toBe("tool.call");
    });

    it("should map lifecycle phases correctly", async () => {
      const { initEventStore } = await import("./event-store.js");
      await initEventStore(DEFAULT_CONFIG);

      capturedListener!({
        ts: 1700000000000,
        sessionKey: "main",
        stream: "lifecycle",
        data: { phase: "end" },
        seq: 3,
        runId: "run-3",
      });

      await vi.waitFor(() => expect(mockPublish).toHaveBeenCalled());

      const parsed = JSON.parse(mockPublish.mock.calls[0][1].toString());
      expect(parsed.type).toBe("run.end");
    });

    it("should handle publish failures without crashing", async () => {
      const { initEventStore } = await import("./event-store.js");
      await initEventStore(DEFAULT_CONFIG);

      mockPublish.mockRejectedValueOnce(new Error("NATS publish timeout"));

      // Should not throw — error is caught in the onAgentEvent handler
      capturedListener!({
        ts: 1700000000000,
        sessionKey: "main",
        stream: "user",
        data: { text: "Hello" },
        seq: 5,
        runId: "run-5",
      });

      // Give the async handler time to settle
      await new Promise((r) => setTimeout(r, 50));

      // Subsequent publishes should still work
      mockPublish.mockResolvedValue({ seq: 2 });
      capturedListener!({
        ts: 1700000001000,
        sessionKey: "main",
        stream: "user",
        data: { text: "Second message" },
        seq: 6,
        runId: "run-6",
      });

      await vi.waitFor(() => expect(mockPublish).toHaveBeenCalledTimes(2));
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Helper functions (exported for testing)
  // ───────────────────────────────────────────────────────────────────────

  describe("toEventType", () => {
    it("should map tool stream with result to tool.result", async () => {
      const { toEventType } = await import("./event-store.js");
      expect(toEventType("tool", { result: "done" })).toBe("tool.result");
      expect(toEventType("tool", { output: "data" })).toBe("tool.result");
    });

    it("should map tool stream without result to tool.call", async () => {
      const { toEventType } = await import("./event-store.js");
      expect(toEventType("tool", { name: "web_search" })).toBe("tool.call");
    });

    it("should map lifecycle phases", async () => {
      const { toEventType } = await import("./event-store.js");
      expect(toEventType("lifecycle", { phase: "start" })).toBe("run.start");
      expect(toEventType("lifecycle", { phase: "end" })).toBe("run.end");
      expect(toEventType("lifecycle", { phase: "error" })).toBe("run.error");
      expect(toEventType("lifecycle", {})).toBe("run.start");
    });

    it("should map user stream to msg.in", async () => {
      const { toEventType } = await import("./event-store.js");
      expect(toEventType("user", {})).toBe("msg.in");
    });

    it("should map assistant stream to msg.out", async () => {
      const { toEventType } = await import("./event-store.js");
      expect(toEventType("assistant", {})).toBe("msg.out");
    });

    it("should map error stream to run.error", async () => {
      const { toEventType } = await import("./event-store.js");
      expect(toEventType("error", {})).toBe("run.error");
    });

    it("should fall back to msg.out for unknown streams", async () => {
      const { toEventType } = await import("./event-store.js");
      expect(toEventType("unknown_stream", {})).toBe("msg.out");
    });
  });

  describe("getAgent", () => {
    it("should return 'main' for main session", async () => {
      const { getAgent } = await import("./event-store.js");
      expect(getAgent("main")).toBe("main");
      expect(getAgent(undefined)).toBe("main");
      expect(getAgent("")).toBe("main");
    });

    it("should extract agent name from session key", async () => {
      const { getAgent } = await import("./event-store.js");
      expect(getAgent("viola:session:123")).toBe("viola");
      expect(getAgent("cerberus:review:456")).toBe("cerberus");
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Shutdown
  // ───────────────────────────────────────────────────────────────────────

  describe("shutdownEventStore", () => {
    it("should drain connection and clear state", async () => {
      const { initEventStore, shutdownEventStore, isEventStoreConnected } =
        await import("./event-store.js");

      await initEventStore(DEFAULT_CONFIG);
      expect(isEventStoreConnected()).toBe(true);

      await shutdownEventStore();
      expect(mockDrain).toHaveBeenCalled();
      expect(isEventStoreConnected()).toBe(false);
    });

    it("should be safe to call when not initialized", async () => {
      const { shutdownEventStore } = await import("./event-store.js");
      await expect(shutdownEventStore()).resolves.toBeUndefined();
    });

    it("should force close if drain times out", async () => {
      mockDrain.mockImplementation(() => new Promise(() => {})); // Never resolves
      const { initEventStore, shutdownEventStore } = await import("./event-store.js");

      await initEventStore(DEFAULT_CONFIG);

      // Shutdown should not hang forever — it has a 5s timeout
      // We use a shorter test timeout expectation
      const shutdownPromise = shutdownEventStore();
      await expect(shutdownPromise).resolves.toBeUndefined();
      expect(mockClose).toHaveBeenCalled();
    }, 10_000);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Status
  // ───────────────────────────────────────────────────────────────────────

  describe("getEventStoreStatus", () => {
    it("should report connected status with counters", async () => {
      const { initEventStore, getEventStoreStatus } = await import("./event-store.js");

      await initEventStore(DEFAULT_CONFIG);
      const status = getEventStoreStatus();

      expect(status.connected).toBe(true);
      expect(status.stream).toBe("test-events");
      expect(status.disconnectCount).toBe(0);
      expect(status.publishFailures).toBe(0);
    });

    it("should report disconnected when not initialized", async () => {
      const { getEventStoreStatus } = await import("./event-store.js");
      const status = getEventStoreStatus();

      expect(status.connected).toBe(false);
      expect(status.stream).toBeNull();
      expect(status.disconnectCount).toBe(0);
      expect(status.publishFailures).toBe(0);
    });

    it("should report disconnected when connection is closed", async () => {
      const { initEventStore, getEventStoreStatus } = await import("./event-store.js");
      await initEventStore(DEFAULT_CONFIG);

      mockIsClosed.mockReturnValue(true);
      const status = getEventStoreStatus();

      expect(status.connected).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // resetForTest
  // ───────────────────────────────────────────────────────────────────────

  describe("resetForTest", () => {
    it("should clear state and allow re-initialization", async () => {
      const { connect } = await import("nats");
      const { initEventStore, resetForTest, isEventStoreConnected } =
        await import("./event-store.js");

      await initEventStore(DEFAULT_CONFIG);
      expect(isEventStoreConnected()).toBe(true);

      resetForTest();
      expect(isEventStoreConnected()).toBe(false);

      // Should be able to init again
      await initEventStore(DEFAULT_CONFIG);
      expect(connect).toHaveBeenCalledTimes(2);
    });
  });
});
