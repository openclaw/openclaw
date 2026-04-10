// Octopus Orchestrator -- Adapter base interface tests (M2-01)
//
// Covers:
//   - Mock adapter implements the full Adapter interface (compile-time + runtime)
//   - AdapterError has correct name, code, and instanceof chain
//   - isAdapterError type guard correctness
//   - SessionRef required fields
//   - CheckpointMeta required fields
//   - AdapterEvent required fields
//   - AdapterError codes are exhaustive (one per code)
//   - stream() returns AsyncIterable (consumer collects via for-await)
//   - Adapter with not_supported send throws AdapterError correctly

import { describe, expect, it } from "vitest";
import type { ArmSpec } from "../wire/schema.ts";
import {
  AdapterError,
  isAdapterError,
  type Adapter,
  type AdapterErrorCode,
  type AdapterEvent,
  type CheckpointMeta,
  type SessionRef,
} from "./base.ts";

// ──────────────────────────────────────────────────────────────────────────
// Mock adapter -- implements all 7 methods of the Adapter interface
// ──────────────────────────────────────────────────────────────────────────

class MockAdapter implements Adapter {
  readonly type = "structured_subagent";

  private readonly events: AdapterEvent[] = [
    { kind: "output", ts: 1000, data: { text: "hello" } },
    { kind: "state", ts: 2000, data: { state: "active" } },
    { kind: "completion", ts: 3000, data: { exit_code: 0 } },
  ];

  async spawn(_spec: ArmSpec): Promise<SessionRef> {
    return {
      adapter_type: this.type,
      session_id: "mock-session-1",
      cwd: "/tmp/mock",
    };
  }

  async resume(ref: SessionRef): Promise<SessionRef> {
    return { ...ref, metadata: { resumed: true } };
  }

  async send(_ref: SessionRef, _message: string): Promise<void> {
    // no-op for the happy path
  }

  async *stream(_ref: SessionRef): AsyncIterable<AdapterEvent> {
    for (const event of this.events) {
      yield event;
    }
  }

  async checkpoint(_ref: SessionRef): Promise<CheckpointMeta> {
    return {
      ts: Date.now(),
      alive: true,
      cwd: "/tmp/mock",
      output_bytes: 42,
      pid: 12345,
      elapsed_ms: 500,
    };
  }

  async terminate(_ref: SessionRef): Promise<void> {
    // no-op
  }

  async health(_ref: SessionRef): Promise<string> {
    return "active";
  }
}

/** Mock adapter whose send() always throws not_supported. */
class ReadOnlyMockAdapter extends MockAdapter {
  override async send(_ref: SessionRef, _message: string): Promise<void> {
    throw new AdapterError("not_supported", "This adapter does not support send");
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────

const MOCK_SESSION_REF: SessionRef = {
  adapter_type: "structured_subagent",
  session_id: "test-session-1",
  cwd: "/tmp/test",
};

const MOCK_ARM_SPEC: ArmSpec = {
  spec_version: 1,
  mission_id: "mission-1",
  adapter_type: "structured_subagent",
  runtime_name: "claude",
  agent_id: "agent-1",
  cwd: "/tmp/test",
  initial_input: "do the thing",
  idempotency_key: "idem-1",
  runtime_options: {},
};

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("Adapter interface (base.ts)", () => {
  describe("mock adapter implements full interface", () => {
    const adapter: Adapter = new MockAdapter();

    it("spawn returns a SessionRef", async () => {
      const ref = await adapter.spawn(MOCK_ARM_SPEC);
      expect(ref.adapter_type).toBe("structured_subagent");
      expect(ref.session_id).toBe("mock-session-1");
      expect(ref.cwd).toBe("/tmp/mock");
    });

    it("resume returns an updated SessionRef", async () => {
      const ref = await adapter.resume(MOCK_SESSION_REF);
      expect(ref.adapter_type).toBe(MOCK_SESSION_REF.adapter_type);
      expect(ref.session_id).toBe(MOCK_SESSION_REF.session_id);
      expect(ref.metadata).toEqual({ resumed: true });
    });

    it("send completes without error", async () => {
      await expect(adapter.send(MOCK_SESSION_REF, "hello")).resolves.toBeUndefined();
    });

    it("checkpoint returns CheckpointMeta", async () => {
      const cp = await adapter.checkpoint(MOCK_SESSION_REF);
      expect(cp.ts).toBeGreaterThan(0);
      expect(cp.alive).toBe(true);
    });

    it("terminate completes without error", async () => {
      await expect(adapter.terminate(MOCK_SESSION_REF)).resolves.toBeUndefined();
    });

    it("health returns a status string", async () => {
      const status = await adapter.health(MOCK_SESSION_REF);
      expect(typeof status).toBe("string");
      expect(status).toBe("active");
    });
  });

  describe("AdapterError", () => {
    it("has correct name and code", () => {
      const err = new AdapterError("spawn_failed", "could not spawn");
      expect(err.name).toBe("AdapterError");
      expect(err.code).toBe("spawn_failed");
      expect(err.message).toBe("could not spawn");
      expect(err).toBeInstanceOf(Error);
    });

    it("carries optional details", () => {
      const details = { pid: 999, signal: "SIGKILL" };
      const err = new AdapterError("internal", "crash", details);
      expect(err.details).toEqual(details);
    });

    it("supports all 6 error codes without compile error", () => {
      const codes: AdapterErrorCode[] = [
        "not_supported",
        "spawn_failed",
        "session_not_found",
        "send_failed",
        "terminated",
        "internal",
      ];
      const errors = codes.map((c) => new AdapterError(c, `test: ${c}`));
      expect(errors).toHaveLength(6);
      for (let i = 0; i < codes.length; i++) {
        expect(errors[i].code).toBe(codes[i]);
      }
    });
  });

  describe("isAdapterError type guard", () => {
    it("returns true for AdapterError", () => {
      const err = new AdapterError("internal", "boom");
      expect(isAdapterError(err)).toBe(true);
    });

    it("returns false for plain Error", () => {
      expect(isAdapterError(new Error("plain"))).toBe(false);
    });

    it("returns false for non-error values", () => {
      expect(isAdapterError(null)).toBe(false);
      expect(isAdapterError(undefined)).toBe(false);
      expect(isAdapterError("string")).toBe(false);
      expect(isAdapterError(42)).toBe(false);
      expect(isAdapterError({ code: "internal", message: "fake" })).toBe(false);
    });
  });

  describe("SessionRef", () => {
    it("has required fields adapter_type and session_id", () => {
      const ref: SessionRef = {
        adapter_type: "cli_exec",
        session_id: "sess-42",
        cwd: "/workspace",
      };
      expect(ref.adapter_type).toBe("cli_exec");
      expect(ref.session_id).toBe("sess-42");
      expect(ref.cwd).toBe("/workspace");
    });

    it("accepts optional fields", () => {
      const ref: SessionRef = {
        adapter_type: "pty_tmux",
        session_id: "sess-99",
        cwd: "/home",
        attach_command: "tmux attach -t sess-99",
        metadata: { cols: 80, rows: 24 },
      };
      expect(ref.attach_command).toBe("tmux attach -t sess-99");
      expect(ref.metadata).toEqual({ cols: 80, rows: 24 });
    });
  });

  describe("CheckpointMeta", () => {
    it("has required fields ts and alive", () => {
      const cp: CheckpointMeta = { ts: 1700000000000, alive: true };
      expect(cp.ts).toBe(1700000000000);
      expect(cp.alive).toBe(true);
    });

    it("accepts all optional fields", () => {
      const cp: CheckpointMeta = {
        ts: 1700000000000,
        alive: false,
        cwd: "/workspace",
        output_bytes: 1024,
        pid: 5678,
        elapsed_ms: 30000,
        metadata: { checkpoint_id: "cp-1" },
      };
      expect(cp.output_bytes).toBe(1024);
      expect(cp.pid).toBe(5678);
      expect(cp.elapsed_ms).toBe(30000);
    });
  });

  describe("AdapterEvent", () => {
    it("has required fields kind and ts", () => {
      const event: AdapterEvent = {
        kind: "output",
        ts: 1700000000000,
        data: { text: "hello" },
      };
      expect(event.kind).toBe("output");
      expect(event.ts).toBe(1700000000000);
      expect(event.data).toEqual({ text: "hello" });
    });

    it("accepts all event kinds", () => {
      const kinds: AdapterEvent["kind"][] = ["output", "state", "cost", "error", "completion"];
      for (const kind of kinds) {
        const event: AdapterEvent = { kind, ts: Date.now(), data: {} };
        expect(event.kind).toBe(kind);
      }
    });
  });

  describe("stream() returns AsyncIterable", () => {
    it("yields events that can be collected via for-await", async () => {
      const adapter: Adapter = new MockAdapter();
      const collected: AdapterEvent[] = [];
      for await (const event of adapter.stream(MOCK_SESSION_REF)) {
        collected.push(event);
      }
      expect(collected).toHaveLength(3);
      expect(collected[0].kind).toBe("output");
      expect(collected[1].kind).toBe("state");
      expect(collected[2].kind).toBe("completion");
    });
  });

  describe("adapter with not_supported send throws correctly", () => {
    it("throws AdapterError with code not_supported", async () => {
      const adapter: Adapter = new ReadOnlyMockAdapter();
      try {
        await adapter.send(MOCK_SESSION_REF, "hello");
        expect.fail("should have thrown");
      } catch (err: unknown) {
        expect(isAdapterError(err)).toBe(true);
        if (isAdapterError(err)) {
          expect(err.code).toBe("not_supported");
          expect(err.name).toBe("AdapterError");
        }
      }
    });
  });
});
