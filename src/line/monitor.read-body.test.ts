import { describe, expect, it } from "vitest";
import { createMockIncomingRequest } from "../../test/helpers/mock-incoming-request.js";
import { readLineWebhookRequestBody } from "./webhook-node.js";

describe("readLineWebhookRequestBody", () => {
  it("reads body within limit", async () => {
    const req = createMockIncomingRequest(['{"events":[{"type":"message"}]}']);
    const body = await readLineWebhookRequestBody(req, 1024);
    expect(body).toContain('"events"');
  });

  it("rejects oversized body", async () => {
    const req = createMockIncomingRequest(["x".repeat(2048)]);
    await expect(readLineWebhookRequestBody(req, 128)).rejects.toThrow("PayloadTooLarge");
  });
});
