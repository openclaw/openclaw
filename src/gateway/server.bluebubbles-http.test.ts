import { beforeEach, describe, expect, it, vi } from "vitest";

const handleBlueBubblesWebhookRequest = vi.hoisted(() => vi.fn(async () => false));

vi.mock("../../extensions/bluebubbles/src/monitor.js", () => ({
  handleBlueBubblesWebhookRequest,
}));

import { AUTH_NONE, sendRequest, withGatewayServer } from "./server-http.test-harness.js";

describe("gateway bluebubbles webhook stage", () => {
  beforeEach(() => {
    handleBlueBubblesWebhookRequest.mockReset();
    handleBlueBubblesWebhookRequest.mockResolvedValue(false);
  });

  it("handles bluebubbles webhooks before plugin http fallthrough", async () => {
    handleBlueBubblesWebhookRequest.mockImplementation(async (req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method !== "POST" || pathname !== "/bluebubbles-webhook") {
        return false;
      }
      res.statusCode = 202;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("bluebubbles-handled");
      return true;
    });

    const handlePluginRequest = vi.fn(async () => false);

    await withGatewayServer({
      prefix: "bluebubbles-webhook-stage",
      resolvedAuth: AUTH_NONE,
      overrides: { handlePluginRequest },
      run: async (server) => {
        const response = await sendRequest(server, {
          path: "/bluebubbles-webhook",
          method: "POST",
        });

        expect(response.res.statusCode).toBe(202);
        expect(response.getBody()).toBe("bluebubbles-handled");
        expect(handlePluginRequest).not.toHaveBeenCalled();
      },
    });
  });
});
