import { beforeEach, describe, expect, it, vi } from "vitest";

const { handleControlUiAvatarRequestMock, handleControlUiHttpRequestMock } = vi.hoisted(() => ({
  handleControlUiAvatarRequestMock: vi.fn(async () => false),
  handleControlUiHttpRequestMock: vi.fn(),
}));

vi.mock("./control-ui.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./control-ui.js")>();
  return {
    ...actual,
    handleControlUiAvatarRequest: handleControlUiAvatarRequestMock,
    handleControlUiHttpRequest: handleControlUiHttpRequestMock,
  };
});

import {
  AUTH_TOKEN,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";

describe("gateway control-ui route", () => {
  beforeEach(() => {
    handleControlUiAvatarRequestMock.mockClear();
    handleControlUiHttpRequestMock.mockReset();
  });

  it("forwards auth context to the control-ui HTTP handler", async () => {
    handleControlUiHttpRequestMock.mockImplementation(async (_req, res) => {
      res.statusCode = 200;
      res.end("ok");
      return true;
    });

    await withGatewayServer({
      prefix: "control-ui-route-auth",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        controlUiEnabled: true,
      },
      run: async (server) => {
        const req = createRequest({
          path: "/__control__/bootstrap-config",
          authorization: "Bearer test-token",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(handleControlUiHttpRequestMock).toHaveBeenCalledTimes(1);
        expect(handleControlUiHttpRequestMock).toHaveBeenCalledWith(
          req,
          res,
          expect.objectContaining({
            auth: AUTH_TOKEN,
            trustedProxies: [],
            allowRealIpFallback: false,
          }),
        );
        expect(res.statusCode).toBe(200);
        expect(getBody()).toBe("ok");
      },
    });
  });
});
