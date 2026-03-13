import { describe, expect, it } from "vitest";
import { BrowserProfileUnavailableError } from "../errors.js";
import { registerBrowserBasicRoutes } from "./basic.js";
import type { BrowserResponse, BrowserRouteHandler, BrowserRouteRegistrar } from "./types.js";

function createApp() {
  const getHandlers = new Map<string, BrowserRouteHandler>();
  const postHandlers = new Map<string, BrowserRouteHandler>();
  const deleteHandlers = new Map<string, BrowserRouteHandler>();
  const app: BrowserRouteRegistrar = {
    get: (path, handler) => void getHandlers.set(path, handler),
    post: (path, handler) => void postHandlers.set(path, handler),
    delete: (path, handler) => void deleteHandlers.set(path, handler),
  };
  return { app, getHandlers };
}

function createResponse() {
  let statusCode = 200;
  let jsonBody: unknown;
  const res: BrowserResponse = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(body) {
      jsonBody = body;
    },
  };
  return {
    res,
    get statusCode() {
      return statusCode;
    },
    get body() {
      return jsonBody;
    },
  };
}

describe("basic browser routes", () => {
  it("maps existing-session status failures to JSON browser errors", async () => {
    const { app, getHandlers } = createApp();
    registerBrowserBasicRoutes(app, {
      state: () => ({
        resolved: {
          enabled: true,
          headless: false,
          noSandbox: false,
          executablePath: undefined,
        },
        profiles: new Map(),
      }),
      forProfile: () =>
        ({
          profile: {
            name: "chrome-live",
            driver: "existing-session",
            cdpPort: 18802,
            cdpUrl: "http://127.0.0.1:18802",
            color: "#00AA00",
            attachOnly: true,
          },
          isHttpReachable: async () => {
            throw new BrowserProfileUnavailableError("attach failed");
          },
          isReachable: async () => true,
        }) as never,
    } as never);

    const handler = getHandlers.get("/");
    expect(handler).toBeTypeOf("function");

    const response = createResponse();
    await handler?.({ params: {}, query: { profile: "chrome-live" } }, response.res);

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ error: "attach failed" });
  });
});
