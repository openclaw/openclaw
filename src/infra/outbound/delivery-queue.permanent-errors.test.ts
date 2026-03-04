import { describe, expect, it } from "vitest";
import { isPermanentDeliveryError } from "./delivery-queue.js";

describe("isPermanentDeliveryError", () => {
  const permanent = [
    "no conversation reference found",
    "chat not found",
    "user not found",
    "bot was blocked by the user",
    "Forbidden: bot was kicked from the group",
    "chat_id is empty",
    "recipient is not a valid user",
    "outbound not configured for channel telegram",
    "ambiguous discord recipient",
    "400 Bad Request: message text is empty",
    "Bad Request (400)",
    "message is not modified",
    "message to delete not found",
    "message can't be deleted",
    "have no rights to send a message",
    "Unknown Channel",
    "Missing Access",
    "Missing Permissions",
  ];

  for (const msg of permanent) {
    it(`marks "${msg}" as permanent`, () => {
      expect(isPermanentDeliveryError(msg)).toBe(true);
    });
  }

  const transient = [
    "ETIMEDOUT",
    "socket hang up",
    "500 Internal Server Error",
    "429 Too Many Requests",
    "ECONNRESET",
    "network error",
  ];

  for (const msg of transient) {
    it(`does NOT mark "${msg}" as permanent`, () => {
      expect(isPermanentDeliveryError(msg)).toBe(false);
    });
  }
});
