import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ToolInterruptManager } from "../tool-interrupt-manager.js";
import { createToolInterruptHandlers } from "./tool-interrupt.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

async function createTempInterruptPath() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tool-interrupt-handler-"));
  return path.join(root, "gateway", "tool-interrupts.json");
}

function baseHandlerArgs(
  overrides: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    req: {
      id: "req-1",
      type: "req",
      method: "tool.interrupt.emit",
    } as GatewayRequestHandlerOptions["req"],
    params: {},
    client: null,
    isWebchatConnect: () => false,
    respond: () => {},
    context: {
      broadcast: () => {},
    } as unknown as GatewayRequestHandlerOptions["context"],
    ...overrides,
  };
}

describe("tool interrupt handlers", () => {
  it("emits requested/resumed events and returns resumed payload", async () => {
    const filePath = await createTempInterruptPath();
    const manager = new ToolInterruptManager({ filePath });
    await manager.load();
    const handlers = createToolInterruptHandlers(manager);
    const broadcasts: Array<{ event: string; payload: unknown }> = [];

    const emitRespond = vi.fn();
    const emitPromise = handlers["tool.interrupt.emit"](
      baseHandlerArgs({
        req: { id: "req-emit", type: "req", method: "tool.interrupt.emit" } as never,
        params: {
          approvalRequestId: "approval-emit-1",
          runId: "run-emit-1",
          sessionKey: "agent:main:main",
          toolCallId: "tool-emit-1",
          toolName: "browser",
          normalizedArgsHash: "a".repeat(64),
          interrupt: { type: "approval", text: "approve this secret token" },
          timeoutMs: 60_000,
        },
        respond: emitRespond,
        context: {
          broadcast: (event: string, payload: unknown) => {
            broadcasts.push({ event, payload });
          },
        } as never,
      }),
    );

    await vi.waitFor(() => {
      expect(broadcasts.some((entry) => entry.event === "tool.interrupt.requested")).toBe(true);
    });

    const requested = broadcasts.find((entry) => entry.event === "tool.interrupt.requested");
    const requestedPayload = (requested?.payload ?? {}) as {
      resumeToken?: string;
      interruptSummary?: Record<string, unknown>;
      interrupt?: unknown;
    };
    expect(typeof requestedPayload.resumeToken).toBe("string");
    expect(requestedPayload.interrupt).toBeUndefined();
    expect(requestedPayload.interruptSummary).toMatchObject({ redacted: true, type: "approval" });

    const resumeRespond = vi.fn();
    await handlers["tool.interrupt.resume"](
      baseHandlerArgs({
        req: { id: "req-resume", type: "req", method: "tool.interrupt.resume" } as never,
        params: {
          approvalRequestId: "approval-emit-1",
          runId: "run-emit-1",
          sessionKey: "agent:main:main",
          toolCallId: "tool-emit-1",
          toolName: "browser",
          normalizedArgsHash: "a".repeat(64),
          resumeToken: requestedPayload.resumeToken,
          decisionReason: "looks safe",
          policyRuleId: "rule-1",
          decisionMeta: { reviewer: "alice" },
          result: {
            content: [{ type: "text", text: "resumed" }],
            details: { status: "completed" },
          },
        },
        respond: resumeRespond,
        context: {
          broadcast: (event: string, payload: unknown) => {
            broadcasts.push({ event, payload });
          },
        } as never,
        client: {
          connect: { client: { id: "client-1", displayName: "Operator" } },
        } as never,
      }),
    );

    expect(resumeRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, alreadyResolved: false, status: "resumed" }),
      undefined,
    );

    await emitPromise;

    expect(emitRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        status: "resumed",
        approvalRequestId: "approval-emit-1",
      }),
      undefined,
    );
    const resumedEvent = broadcasts.find((entry) => entry.event === "tool.interrupt.resumed");
    expect(resumedEvent).toBeDefined();
    expect(resumedEvent?.payload).toMatchObject({
      decisionReason: "looks safe",
      policyRuleId: "rule-1",
    });
    manager.stop();
  });

  it("lists pending interrupts for approval UI recovery", async () => {
    const filePath = await createTempInterruptPath();
    const manager = new ToolInterruptManager({ filePath });
    await manager.load();
    const handlers = createToolInterruptHandlers(manager);

    const emitRespond = vi.fn();
    const emitPromise = handlers["tool.interrupt.emit"](
      baseHandlerArgs({
        req: { id: "req-emit", type: "req", method: "tool.interrupt.emit" } as never,
        params: {
          approvalRequestId: "approval-list-1",
          runId: "run-list-1",
          sessionKey: "agent:main:main",
          toolCallId: "tool-list-1",
          toolName: "browser",
          normalizedArgsHash: "d".repeat(64),
          interrupt: { type: "approval", text: "approve this" },
          timeoutMs: 60_000,
          twoPhase: true,
        },
        respond: emitRespond,
      }),
    );

    await vi.waitFor(() => {
      expect(emitRespond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "accepted" }),
        undefined,
      );
    });

    const listRespond = vi.fn();
    await handlers["tool.interrupt.list"](
      baseHandlerArgs({
        req: { id: "req-list", type: "req", method: "tool.interrupt.list" } as never,
        params: { state: "pending" },
        respond: listRespond,
      }),
    );

    expect(listRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        state: "pending",
        interrupts: [
          expect.objectContaining({
            approvalRequestId: "approval-list-1",
            toolName: "browser",
            normalizedArgsHash: "d".repeat(64),
            resumeToken: expect.any(String),
          }),
        ],
      }),
      undefined,
    );

    const listedPayload = listRespond.mock.calls[0]?.[1] as
      | { interrupts?: Array<{ resumeToken?: string }> }
      | undefined;
    const resumeToken = listedPayload?.interrupts?.[0]?.resumeToken;
    await handlers["tool.interrupt.resume"](
      baseHandlerArgs({
        req: { id: "req-resume", type: "req", method: "tool.interrupt.resume" } as never,
        params: {
          approvalRequestId: "approval-list-1",
          runId: "run-list-1",
          sessionKey: "agent:main:main",
          toolCallId: "tool-list-1",
          toolName: "browser",
          normalizedArgsHash: "d".repeat(64),
          resumeToken,
          result: { ok: true },
        },
        respond: vi.fn(),
      }),
    );

    await emitPromise;
    manager.stop();
  });

  it("returns deterministic terminal state for duplicate resume RPC calls", async () => {
    const filePath = await createTempInterruptPath();
    const manager = new ToolInterruptManager({ filePath });
    await manager.load();
    const handlers = createToolInterruptHandlers(manager);
    const broadcasts: Array<{ event: string; payload: unknown }> = [];

    const emitPromise = handlers["tool.interrupt.emit"](
      baseHandlerArgs({
        req: { id: "req-emit", type: "req", method: "tool.interrupt.emit" } as never,
        params: {
          approvalRequestId: "approval-idempotent-1",
          runId: "run-idempotent-1",
          sessionKey: "agent:main:main",
          toolCallId: "tool-idempotent-1",
          interrupt: { type: "approval", text: "approve" },
          timeoutMs: 60_000,
        },
        respond: vi.fn(),
        context: {
          broadcast: (event: string, payload: unknown) => broadcasts.push({ event, payload }),
        } as never,
      }),
    );

    await vi.waitFor(() => {
      expect(broadcasts.some((entry) => entry.event === "tool.interrupt.requested")).toBe(true);
    });
    const requested = broadcasts.find((entry) => entry.event === "tool.interrupt.requested");
    const resumeToken = (requested?.payload as { resumeToken?: string } | undefined)?.resumeToken;

    const respondA = vi.fn();
    await handlers["tool.interrupt.resume"](
      baseHandlerArgs({
        req: { id: "req-resume-a", type: "req", method: "tool.interrupt.resume" } as never,
        params: {
          approvalRequestId: "approval-idempotent-1",
          runId: "run-idempotent-1",
          sessionKey: "agent:main:main",
          toolCallId: "tool-idempotent-1",
          resumeToken,
          result: { approved: true },
        },
        respond: respondA,
        context: {
          broadcast: (event: string, payload: unknown) => broadcasts.push({ event, payload }),
        } as never,
      }),
    );

    const respondB = vi.fn();
    await handlers["tool.interrupt.resume"](
      baseHandlerArgs({
        req: { id: "req-resume-b", type: "req", method: "tool.interrupt.resume" } as never,
        params: {
          approvalRequestId: "approval-idempotent-1",
          runId: "run-idempotent-1",
          sessionKey: "agent:main:main",
          toolCallId: "tool-idempotent-1",
          resumeToken,
          result: { approved: true },
        },
        respond: respondB,
        context: {
          broadcast: (event: string, payload: unknown) => broadcasts.push({ event, payload }),
        } as never,
      }),
    );

    const payloadA = respondA.mock.calls[0]?.[1] as Record<string, unknown>;
    const payloadB = respondB.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payloadA).toMatchObject({ ok: true, alreadyResolved: false, status: "resumed" });
    expect(payloadB).toMatchObject({ ok: true, alreadyResolved: true, status: "resumed" });
    expect(payloadB.result).toEqual(payloadA.result);

    await emitPromise;
    manager.stop();
  });

  it("allows replayed emit calls to return already resumed payload", async () => {
    const filePath = await createTempInterruptPath();
    const manager = new ToolInterruptManager({ filePath });
    await manager.load();
    const handlers = createToolInterruptHandlers(manager);

    const broadcasts: Array<{ event: string; payload: unknown }> = [];

    const emitRespond = vi.fn();
    const emitPromise = handlers["tool.interrupt.emit"](
      baseHandlerArgs({
        req: { id: "req-emit", type: "req", method: "tool.interrupt.emit" } as never,
        params: {
          approvalRequestId: "approval-replay-1",
          runId: "run-replay-1",
          sessionKey: "agent:main:main",
          toolCallId: "tool-replay-1",
          interrupt: { type: "approval", text: "approve this" },
          timeoutMs: 60_000,
        },
        respond: emitRespond,
        context: {
          broadcast: (event: string, payload: unknown) => {
            broadcasts.push({ event, payload });
          },
        } as unknown as GatewayRequestHandlerOptions["context"],
      }),
    );

    await vi.waitFor(() => {
      expect(broadcasts.some((entry) => entry.event === "tool.interrupt.requested")).toBe(true);
    });

    const requested = broadcasts.find((entry) => entry.event === "tool.interrupt.requested");
    const requestedPayload = (requested?.payload ?? {}) as {
      resumeToken?: string;
    };

    await handlers["tool.interrupt.resume"](
      baseHandlerArgs({
        req: { id: "req-resume", type: "req", method: "tool.interrupt.resume" } as never,
        params: {
          approvalRequestId: "approval-replay-1",
          runId: "run-replay-1",
          sessionKey: "agent:main:main",
          toolCallId: "tool-replay-1",
          resumeToken: requestedPayload.resumeToken,
          result: { ok: true, note: "done" },
        },
        respond: vi.fn(),
      }),
    );

    await emitPromise;

    const replayRespond = vi.fn();
    await handlers["tool.interrupt.emit"](
      baseHandlerArgs({
        req: { id: "req-replay", type: "req", method: "tool.interrupt.emit" } as never,
        params: {
          approvalRequestId: "approval-replay-1",
          runId: "run-replay-1",
          sessionKey: "agent:main:main",
          toolCallId: "tool-replay-1",
          interrupt: { type: "approval", text: "approve this" },
          timeoutMs: 60_000,
        },
        respond: replayRespond,
      }),
    );

    expect(replayRespond).toHaveBeenCalled();
    expect(replayRespond.mock.calls[0]?.[0]).toBe(true);
    expect(replayRespond.mock.calls[0]?.[1]).toMatchObject({
      status: "resumed",
      approvalRequestId: "approval-replay-1",
      runId: "run-replay-1",
      sessionKey: "agent:main:main",
      toolCallId: "tool-replay-1",
      result: { ok: true, note: "done" },
    });

    manager.stop();
  });
});
