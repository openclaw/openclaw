import { beforeEach, describe, expect, it, vi } from "vitest";

const deliverOutboundPayloadsMock = vi.fn();
const resolveOutboundTargetMock = vi.fn();

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: (...args: unknown[]) => deliverOutboundPayloadsMock(...args),
}));

vi.mock("./outbound/targets.js", () => ({
  resolveOutboundTarget: (...args: unknown[]) => resolveOutboundTargetMock(...args),
}));

const { isSensitiveSystemNotification, sendSystemNotificationToTelegramAdmin } =
  await import("./system-notifications.js");

describe("system-notifications", () => {
  beforeEach(() => {
    deliverOutboundPayloadsMock.mockReset().mockResolvedValue([]);
    resolveOutboundTargetMock.mockReset().mockReturnValue({ ok: true, to: "6438593762" });
  });

  it("detects sensitive notification patterns", () => {
    expect(isSensitiveSystemNotification("Pairing code: ABCD1234")).toBe(true);
    expect(isSensitiveSystemNotification("OpenClaw: access not configured.")).toBe(true);
    expect(isSensitiveSystemNotification("WhatsApp gateway connected")).toBe(true);
    expect(isSensitiveSystemNotification("normal user reply")).toBe(false);
  });

  it("sends sensitive notifications to telegram allowFrom target", async () => {
    const sent = await sendSystemNotificationToTelegramAdmin({
      cfg: {
        channels: {
          telegram: {
            allowFrom: ["6438593762"],
          },
        },
      } as any,
      text: "Pairing code: ABCD1234",
      reason: "explicit_service_status_request",
    });

    expect(sent).toBe(true);
    expect(resolveOutboundTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "6438593762",
      }),
    );
    expect(deliverOutboundPayloadsMock).toHaveBeenCalled();
  });

  it("does not send when cross-app reason is missing", async () => {
    const sent = await sendSystemNotificationToTelegramAdmin({
      cfg: {
        channels: {
          telegram: {
            allowFrom: ["6438593762"],
          },
        },
      } as any,
      text: "Pairing code: ABCD1234",
    });

    expect(sent).toBe(false);
    expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
  });

  it("sends for no-response escalation reason", async () => {
    const sent = await sendSystemNotificationToTelegramAdmin({
      cfg: {
        channels: {
          telegram: {
            allowFrom: ["6438593762"],
          },
        },
      } as any,
      text: "OpenClaw: access not configured.",
      reason: "no_response_escalation",
    });

    expect(sent).toBe(true);
    expect(deliverOutboundPayloadsMock).toHaveBeenCalled();
  });

  it("does not send non-sensitive notifications", async () => {
    const sent = await sendSystemNotificationToTelegramAdmin({
      cfg: {
        channels: {
          telegram: {
            allowFrom: ["6438593762"],
          },
        },
      } as any,
      text: "Routine note",
      reason: "explicit_service_status_request",
    });

    expect(sent).toBe(false);
    expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
  });
});
