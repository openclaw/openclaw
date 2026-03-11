import { describe, it, expect, beforeEach, vi } from "vitest";
import { NodeRegistry } from "./node-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import * as decisionOverride from "../clarityburst/decision-override.js";

/**
 * Tests for canvas safety gate enforcement in NodeRegistry.invoke()
 * 
 * Validates that:
 * 1. PROCEED outcomes allow dispatch
 * 2. ABSTAIN_CONFIRM outcomes block dispatch
 * 3. ABSTAIN_CLARIFY outcomes block dispatch
 * 4. Blocked outcomes return proper error responses
 */

describe("NodeRegistry.invoke - Canvas Safety Gate Enforcement", () => {
  let registry: NodeRegistry;
  let mockClient: GatewayWsClient;
  let sendEventSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    registry = new NodeRegistry();
    
    // Create mock WebSocket client
    mockClient = {
      connId: "test-conn-id",
      connect: {
        device: { id: "test-device-id" },
        client: {
          id: "test-client-id",
          displayName: "Test Client",
          platform: "macos",
          version: "1.0.0",
        },
        caps: ["shell", "file_system"],
      },
      socket: {
        send: vi.fn(),
      },
    } as unknown as GatewayWsClient;

    registry.register(mockClient, {});
    sendEventSpy = vi.spyOn(registry, "sendEvent");
  });

  it("PROCEED outcome: dispatches node.invoke.request and waits for response", async () => {
    // Mock applyCanvasUiOverrides to return PROCEED
    const proceedOutcome = { outcome: "PROCEED", contractId: null };
    vi.spyOn(decisionOverride, "applyCanvasUiOverrides").mockResolvedValueOnce(
      proceedOutcome as decisionOverride.OverrideOutcome
    );

    // Spy on the internal socket send to detect actual dispatch
    const socketSendSpy = vi.spyOn(mockClient.socket, "send");

    // Invoke with short timeout to avoid hanging
    const invokePromise = registry.invoke({
      nodeId: "test-device-id",
      command: "testCommand",
      params: { arg: "value" },
      timeoutMs: 100,
    });

    // Give time for the async canvas gate to complete and dispatch
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Verify that the socket.send was called (indicating dispatch occurred)
    expect(socketSendSpy).toHaveBeenCalled();
    const sentData = socketSendSpy.mock.calls[0]?.[0];
    if (sentData) {
      const parsed = JSON.parse(sentData as string);
      expect(parsed.event).toBe("node.invoke.request");
      expect(parsed.payload.command).toBe("testCommand");
    }

    // Wait for timeout response
    const result = await invokePromise;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TIMEOUT");
  });

  it("ABSTAIN_CONFIRM outcome: blocks dispatch and returns CANVAS_CONFIRMATION_REQUIRED error", async () => {
    // Mock applyCanvasUiOverrides to return ABSTAIN_CONFIRM
    const confirmOutcome = {
      outcome: "ABSTAIN_CONFIRM",
      reason: "CONFIRM_REQUIRED",
      contractId: "test-contract",
    } as decisionOverride.AbstainConfirmOutcome;

    vi.spyOn(decisionOverride, "applyCanvasUiOverrides").mockResolvedValueOnce(
      confirmOutcome as decisionOverride.OverrideOutcome
    );

    const result = await registry.invoke({
      nodeId: "test-device-id",
      command: "testCommand",
      params: { arg: "value" },
    });

    // Verify dispatch was blocked
    expect(sendEventSpy).not.toHaveBeenCalled();

    // Verify error response
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CANVAS_CONFIRMATION_REQUIRED");
    expect(result.error?.message).toContain("Canvas UI confirmation required");
  });

  it("ABSTAIN_CLARIFY outcome (router_outage): blocks dispatch and returns CANVAS_ABSTAIN error", async () => {
    // Mock applyCanvasUiOverrides to return ABSTAIN_CLARIFY (router_outage)
    const clarifyOutcome = {
      outcome: "ABSTAIN_CLARIFY",
      reason: "router_outage",
      contractId: null,
      instructions: "Router unavailable",
    } as decisionOverride.AbstainClarifyOutcome;

    vi.spyOn(decisionOverride, "applyCanvasUiOverrides").mockResolvedValueOnce(
      clarifyOutcome as decisionOverride.OverrideOutcome
    );

    const result = await registry.invoke({
      nodeId: "test-device-id",
      command: "testCommand",
      params: { arg: "value" },
    });

    // Verify dispatch was blocked
    expect(sendEventSpy).not.toHaveBeenCalled();

    // Verify error response
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CANVAS_ABSTAIN");
    expect(result.error?.message).toContain("Canvas UI operation blocked");
    expect(result.error?.message).toContain("router_outage");
  });

  it("ABSTAIN_CLARIFY outcome (low confidence): blocks dispatch and returns CANVAS_ABSTAIN error", async () => {
    // Mock applyCanvasUiOverrides to return ABSTAIN_CLARIFY (low confidence)
    const clarifyOutcome = {
      outcome: "ABSTAIN_CLARIFY",
      reason: "LOW_DOMINANCE_OR_CONFIDENCE",
      contractId: "test-contract",
      instructions: "Low confidence score",
    } as decisionOverride.AbstainClarifyOutcome;

    vi.spyOn(decisionOverride, "applyCanvasUiOverrides").mockResolvedValueOnce(
      clarifyOutcome as decisionOverride.OverrideOutcome
    );

    const result = await registry.invoke({
      nodeId: "test-device-id",
      command: "testCommand",
      params: { arg: "value" },
    });

    // Verify dispatch was blocked
    expect(sendEventSpy).not.toHaveBeenCalled();

    // Verify error response
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CANVAS_ABSTAIN");
    expect(result.error?.message).toContain("Canvas UI operation blocked");
    expect(result.error?.message).toContain("LOW_DOMINANCE_OR_CONFIDENCE");
  });

  it("ABSTAIN_CLARIFY outcome (incomplete pack policy): blocks dispatch", async () => {
    // Mock applyCanvasUiOverrides to return ABSTAIN_CLARIFY (incomplete policy)
    const clarifyOutcome = {
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: "Missing thresholds",
    } as decisionOverride.AbstainClarifyOutcome;

    vi.spyOn(decisionOverride, "applyCanvasUiOverrides").mockResolvedValueOnce(
      clarifyOutcome as decisionOverride.OverrideOutcome
    );

    const result = await registry.invoke({
      nodeId: "test-device-id",
      command: "testCommand",
    });

    // Verify dispatch was blocked
    expect(sendEventSpy).not.toHaveBeenCalled();

    // Verify error response
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CANVAS_ABSTAIN");
    expect(result.error?.message).toContain("PACK_POLICY_INCOMPLETE");
  });

  it("Returns NOT_CONNECTED error if node is not registered", async () => {
    // Don't register the node, invoke directly
    const emptyRegistry = new NodeRegistry();

    const result = await emptyRegistry.invoke({
      nodeId: "unregistered-node",
      command: "testCommand",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_CONNECTED");
  });

  it("Preserves canvas outcome reason in error message", async () => {
    const customReason = "Custom gate reason";
    const clarifyOutcome = {
      outcome: "ABSTAIN_CLARIFY",
      reason: "router_outage" as const,
      contractId: null,
      instructions: customReason,
    } as decisionOverride.AbstainClarifyOutcome;

    vi.spyOn(decisionOverride, "applyCanvasUiOverrides").mockResolvedValueOnce(
      clarifyOutcome as decisionOverride.OverrideOutcome
    );

    const result = await registry.invoke({
      nodeId: "test-device-id",
      command: "testCommand",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CANVAS_ABSTAIN");
    expect(result.error?.message).toContain("router_outage");
  });

  it("Canvas gate is called with correct context parameters", async () => {
    const mockApply = vi
      .spyOn(decisionOverride, "applyCanvasUiOverrides")
      .mockResolvedValueOnce({
        outcome: "PROCEED",
        contractId: null,
      } as decisionOverride.OverrideOutcome);

    const commandName = "myCommand";
    const invokePromise = registry.invoke({
      nodeId: "test-device-id",
      command: commandName,
      timeoutMs: 50,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockApply).toHaveBeenCalledWith(
      expect.objectContaining({
        stageId: "CANVAS_UI",
        userConfirmed: false,
        componentType: commandName,
        canvasId: expect.any(String),
      })
    );

    await invokePromise;
  });

  it("No fallback dispatch allowed after ABSTAIN outcomes", async () => {
    const outcomes = [
      { outcome: "ABSTAIN_CONFIRM", reason: "CONFIRM_REQUIRED", contractId: "test" },
      { outcome: "ABSTAIN_CLARIFY", reason: "router_outage", contractId: null },
      { outcome: "ABSTAIN_CLARIFY", reason: "LOW_DOMINANCE_OR_CONFIDENCE", contractId: "test" },
    ] as const;

    for (const outcome of outcomes) {
      vi.spyOn(decisionOverride, "applyCanvasUiOverrides").mockResolvedValueOnce(
        outcome as decisionOverride.OverrideOutcome
      );

      const result = await registry.invoke({
        nodeId: "test-device-id",
        command: "testCommand",
      });

      expect(result.ok).toBe(false);
      expect(sendEventSpy).not.toHaveBeenCalled();
    }
  });
});
