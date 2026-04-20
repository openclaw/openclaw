import { beforeEach, describe, expect, it, vi } from "vitest";

const { handleManagedOutgoingImageHttpRequestMock } = vi.hoisted(() => ({
  handleManagedOutgoingImageHttpRequestMock: vi.fn(),
}));

vi.mock("./managed-image-attachments.js", () => ({
  handleManagedOutgoingImageHttpRequest: handleManagedOutgoingImageHttpRequestMock,
}));

import {
  AUTH_NONE,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";

describe("gateway managed outgoing image route", () => {
  beforeEach(() => {
    handleManagedOutgoingImageHttpRequestMock.mockReset();
  });

  it("dispatches matching paths to the managed image handler", async () => {
    handleManagedOutgoingImageHttpRequestMock.mockImplementation(async (_req, res) => {
      res.statusCode = 200;
      res.end("ok");
      return true;
    });

    await withGatewayServer({
      prefix: "managed-outgoing-image-route",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createRequest({
          path: "/api/chat/media/outgoing/agent%3Amain%3Amain/att-123/full",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(handleManagedOutgoingImageHttpRequestMock).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(200);
        expect(getBody()).toBe("ok");
      },
    });
  });
});
