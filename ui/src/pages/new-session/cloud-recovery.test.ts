import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCloudSessionRecovery,
  readCloudSessionRecovery,
  writeCloudSessionRecovery,
} from "./cloud-recovery.ts";

const recovery = {
  sessionKey: "agent:cloud:one",
  messageId: "message-1",
  message: "run remotely",
  profileId: "aws",
  agentId: "cloud",
  gatewayUrl: "ws://gateway.example",
  recoveryScope: "principal-a",
};

describe("cloud session recovery", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("round-trips a gateway-scoped recovery record", () => {
    expect(writeCloudSessionRecovery(recovery)).toBe(true);
    expect(readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope)).toEqual(recovery);
    expect(readCloudSessionRecovery("ws://other.example", recovery.recoveryScope)).toBeNull();
    expect(readCloudSessionRecovery(recovery.gatewayUrl, "principal-b")).toBeNull();

    clearCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope);
    expect(readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope)).toBeNull();
  });

  it("fails closed when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("storage disabled", "SecurityError");
    });
    expect(writeCloudSessionRecovery(recovery)).toBe(false);
  });

  it("round-trips an attachment-only first turn", () => {
    const attachmentRecovery = {
      ...recovery,
      message: "",
      attachments: [{ type: "file", mimeType: "text/plain", content: "aGVsbG8=" }],
    };
    expect(writeCloudSessionRecovery(attachmentRecovery)).toBe(true);
    expect(readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope)).toEqual(
      attachmentRecovery,
    );
  });

  it("does not let stale cleanup erase a newer recovery record", () => {
    expect(writeCloudSessionRecovery(recovery)).toBe(true);
    clearCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope, "agent:cloud:older");
    expect(readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope)).toEqual(recovery);

    clearCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope, recovery.sessionKey);
    expect(readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope)).toBeNull();
  });

  it("rejects malformed records", () => {
    sessionStorage.setItem(
      `openclaw.new-session.cloud-recovery.v1:${recovery.gatewayUrl}:${recovery.recoveryScope}`,
      JSON.stringify({ ...recovery, messageId: "" }),
    );
    expect(readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope)).toBeNull();
  });
});
