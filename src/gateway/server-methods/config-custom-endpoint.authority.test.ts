import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { createCustomEndpointHandler } from "./config-custom-endpoint.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

// Only OS DNS is synthetic; discovery, guarded fetch, and HTTP dispatch run unchanged.
const dns = vi.hoisted(() => ({ beforeResolve: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...actual,
    lookup: async (...args: Parameters<typeof actual.lookup>) => {
      if (args[0] !== "custom-discovery.localhost") {
        return actual.lookup(...args);
      }
      await dns.beforeResolve?.();
      return [{ address: "127.0.0.1", family: 4 }];
    },
  };
});

const handler = createCustomEndpointHandler(async () => {
  throw new Error("Discovery must not write config");
});

describe("custom endpoint discovery request authority", () => {
  let server: Server;
  let baseUrl: string;
  let requests: { url: string | undefined; authorization: string | undefined }[];

  beforeEach(async () => {
    setRuntimeConfigSnapshot({});
    dns.beforeResolve = undefined;
    requests = [];
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ]) {
      vi.stubEnv(name, "");
    }
    server = createServer((incoming, response) => {
      requests.push({ url: incoming.url, authorization: incoming.headers.authorization });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "synthetic-chat" }] }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP recorder");
    }
    baseUrl = `http://custom-discovery.localhost:${address.port}/v1`;
  });

  afterEach(async () => {
    dns.beforeResolve = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    vi.unstubAllEnvs();
    clearRuntimeConfigSnapshot();
  });

  function request(
    options: {
      local?: boolean;
      scopes?: string[];
      current?: () => boolean;
      signal?: AbortSignal;
      noAuth?: boolean;
    } = {},
  ) {
    const client = {
      connId: "custom-discovery",
      connect: { role: "operator", scopes: options.scopes ?? ["operator.admin"] },
      internal: { isLocalClient: options.local ?? true },
    } as GatewayWsClient;
    const context = {
      getRuntimeConfig: () => ({}),
      getCommittedRuntimeConfig: () => ({}),
    } as GatewayRequestContext;
    const respond = vi.fn<RespondFn>();
    const pending = handleGatewayRequest({
      req: {
        type: "req",
        id: "custom-discovery",
        method: "config.customEndpoint",
        params: {
          action: "discover",
          provider: "synthetic-custom",
          api: "openai-completions",
          baseUrl,
          noAuth: options.noAuth ?? true,
          apiKey: "synthetic-key",
        },
      },
      client,
      context,
      respond,
      signal: options.signal,
      hasCurrentClientAuthority: options.current,
      isWebchatConnect: () => false,
      extraHandlers: { "config.customEndpoint": handler },
    });
    return { pending, respond, client };
  }

  it.each([true, false])("reaches the real HTTP recorder with noAuth=%s", async (noAuth) => {
    const { pending, respond } = request({ noAuth });
    await pending;
    expect(respond).toHaveBeenCalledWith(
      true,
      { models: ["synthetic-chat"], inferenceTested: false },
      undefined,
    );
    expect(requests).toEqual([
      { url: "/v1/models", authorization: noAuth ? undefined : "Bearer synthetic-key" },
    ]);
  });

  it.each(["remote", "read-only", "revoked"] as const)(
    "refuses %s discovery before endpoint I/O",
    async (reason) => {
      const { pending, respond } = request({
        local: reason !== "remote",
        scopes: reason === "read-only" ? ["operator.read"] : undefined,
        current: () => reason !== "revoked",
      });
      if (reason === "revoked") {
        await expect(pending).rejects.toThrow("Gateway requester authority changed");
      } else {
        await pending;
        expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
      }
      expect(requests).toEqual([]);
    },
  );

  it.each(["revoked", "canceled", "read-only"] as const)(
    "refuses %s authority after real guarded-fetch DNS preparation",
    async (reason) => {
      const entered = createDeferred();
      const release = createDeferred();
      dns.beforeResolve = async () => {
        entered.resolve();
        await release.promise;
      };
      const controller = new AbortController();
      let current = true;
      const { pending, respond, client } = request({
        current: () => current,
        signal: controller.signal,
      });
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error(JSON.stringify(respond.mock.calls));
        }),
      ]);
      if (reason === "revoked") {
        current = false;
      }
      if (reason === "canceled") {
        controller.abort(new Error("Synthetic request canceled"));
      }
      if (reason === "read-only") {
        client.connect.scopes = ["operator.read"];
      }
      release.resolve();
      await pending;
      expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
      expect(requests).toEqual([]);
    },
  );
});
