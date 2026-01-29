import { afterEach, describe, expect, it, vi } from "vitest";

import type { MoltbotConfig } from "../config/config.js";
import {
  buildTelegramExecApprovalCallbackData,
  createExecApprovalForwarder,
  parseTelegramExecApprovalCallbackData,
} from "./exec-approval-forwarder.js";

describe("telegram exec approval callback data", () => {
  it("builds callback data with correct format", () => {
    const data = buildTelegramExecApprovalCallbackData("uuid-123", "allow-once");
    expect(data).toBe("execapproval:uuid-123:allow-once");
  });

  it("builds callback data for all decision types", () => {
    expect(buildTelegramExecApprovalCallbackData("id", "allow-once")).toBe(
      "execapproval:id:allow-once",
    );
    expect(buildTelegramExecApprovalCallbackData("id", "allow-always")).toBe(
      "execapproval:id:allow-always",
    );
    expect(buildTelegramExecApprovalCallbackData("id", "deny")).toBe("execapproval:id:deny");
  });

  it("parses valid callback data", () => {
    const result = parseTelegramExecApprovalCallbackData("execapproval:uuid-123:allow-once");
    expect(result).toEqual({ approvalId: "uuid-123", action: "allow-once" });
  });

  it("parses all decision types", () => {
    expect(parseTelegramExecApprovalCallbackData("execapproval:id:allow-once")).toEqual({
      approvalId: "id",
      action: "allow-once",
    });
    expect(parseTelegramExecApprovalCallbackData("execapproval:id:allow-always")).toEqual({
      approvalId: "id",
      action: "allow-always",
    });
    expect(parseTelegramExecApprovalCallbackData("execapproval:id:deny")).toEqual({
      approvalId: "id",
      action: "deny",
    });
  });

  it("returns null for invalid format", () => {
    expect(parseTelegramExecApprovalCallbackData("invalid")).toBeNull();
    expect(parseTelegramExecApprovalCallbackData("other:id:deny")).toBeNull();
    expect(parseTelegramExecApprovalCallbackData("execapproval:id")).toBeNull();
    expect(parseTelegramExecApprovalCallbackData("execapproval:id:invalid-action")).toBeNull();
  });

  it("roundtrips callback data correctly", () => {
    const original = buildTelegramExecApprovalCallbackData("my-approval-id", "allow-always");
    const parsed = parseTelegramExecApprovalCallbackData(original);
    expect(parsed).toEqual({ approvalId: "my-approval-id", action: "allow-always" });
  });
});

const baseRequest = {
  id: "req-1",
  request: {
    command: "echo hello",
    agentId: "main",
    sessionKey: "agent:main:main",
  },
  createdAtMs: 1000,
  expiresAtMs: 6000,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("exec approval forwarder", () => {
  it("forwards to session target and resolves", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
    const cfg = {
      approvals: { exec: { enabled: true, mode: "session" } },
    } as MoltbotConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      nowMs: () => 1000,
      resolveSessionTarget: () => ({ channel: "slack", to: "U1" }),
    });

    await forwarder.handleRequested(baseRequest);
    expect(deliver).toHaveBeenCalledTimes(1);

    await forwarder.handleResolved({
      id: baseRequest.id,
      decision: "allow-once",
      resolvedBy: "slack:U1",
      ts: 2000,
    });
    expect(deliver).toHaveBeenCalledTimes(2);

    await vi.runAllTimersAsync();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("forwards to explicit targets and expires", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "123" }],
        },
      },
    } as MoltbotConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
    });

    await forwarder.handleRequested(baseRequest);
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});
