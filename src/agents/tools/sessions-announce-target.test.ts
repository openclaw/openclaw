import { describe, expect, it, vi } from "vitest";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import { resolveAnnounceTargetFromKey } from "./sessions-send-helpers.js";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

describe("sessions regression tests", () => {
  describe("resolveAnnounceTargetFromKey", () => {
    it("should return null for 'main' channel internal keys even if kind is 'thread'", () => {
      const key = "agent:main:main:thread:9999";
      const target = resolveAnnounceTargetFromKey(key);
      expect(target).toBeNull();
    });

    it("should still resolve for external channels", () => {
      const key = "agent:main:telegram:thread:1234:5678";
      const target = resolveAnnounceTargetFromKey(key);
      expect(target).toEqual({
        channel: "telegram",
        to: "group:1234",
        threadId: "5678",
      });
    });
  });

  describe("resolveAnnounceTarget", () => {
    it("should accept numeric threadId from deliveryContext and convert to string", async () => {
      callGatewayMock.mockResolvedValueOnce({
        sessions: [
          {
            key: "agent:main:session1",
            deliveryContext: {
              channel: "telegram",
              to: "12345",
              threadId: 9999, // Numeric threadId
            },
          },
        ],
      });

      const target = await resolveAnnounceTarget({
        sessionKey: "agent:main:session1",
        displayKey: "session1",
      });

      expect(target).toEqual({
        channel: "telegram",
        to: "12345",
        accountId: undefined,
        threadId: "9999", // Should be string
      });
    });

    it("should accept numeric lastThreadId from match and convert to string", async () => {
      callGatewayMock.mockResolvedValueOnce({
        sessions: [
          {
            key: "agent:main:session2",
            lastChannel: "discord",
            lastTo: "67890",
            lastThreadId: 8888, // Numeric lastThreadId
          },
        ],
      });

      const target = await resolveAnnounceTarget({
        sessionKey: "agent:main:session2",
        displayKey: "session2",
      });

      expect(target).toEqual({
        channel: "discord",
        to: "67890",
        accountId: undefined,
        threadId: "8888", // Should be string
      });
    });
  });
});
