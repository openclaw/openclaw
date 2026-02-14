import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { HooksConfigResolved } from "./hooks.js";

const { readJsonBodyMock } = vi.hoisted(() => ({
  readJsonBodyMock: vi.fn(),
}));

vi.mock("./hooks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hooks.js")>();
  return {
    ...actual,
    readJsonBody: readJsonBodyMock,
  };
});

import { createHooksRequestHandler } from "./server-http.js";

function createHooksConfig(): HooksConfigResolved {
  return {
    basePath: "/hooks",
    token: "hook-secret",
    maxBodyBytes: 1024,
    mappings: [],
    agentPolicy: {
      defaultAgentId: "main",
      knownAgentIds: new Set(["main"]),
      allowedAgentIds: undefined,
    },
    sessionPolicy: {
      allowRequestSessionKey: false,
      defaultSessionKey: undefined,
      allowedSessionKeyPrefixes: undefined,
    },
  };
}

function createRequest(): IncomingMessage {
  return {
    method: "POST",
    url: "/hooks/wake",
    headers: {
      host: "127.0.0.1:18789",
      authorization: "Bearer hook-secret",
    },
    socket: { remoteAddress: "127.0.0.1" },
  } as IncomingMessage;
}

function createResponse(): {
  res: ServerResponse;
  end: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
} {
  const setHeader = vi.fn();
  const end = vi.fn();
  const res = {
    statusCode: 200,
    setHeader,
    end,
  } as unknown as ServerResponse;
  return { res, end, setHeader };
}

describe("createHooksRequestHandler timeout status mapping", () => {
  beforeEach(() => {
    readJsonBodyMock.mockReset();
  });

  test("returns 408 for request body timeout", async () => {
    readJsonBodyMock.mockResolvedValue({ ok: false, error: "request body timeout" });
    const dispatchWakeHook = vi.fn();
    const dispatchAgentHook = vi.fn(() => "run-1");
    const handler = createHooksRequestHandler({
      getHooksConfig: () => createHooksConfig(),
      bindHost: "127.0.0.1",
      port: 18789,
      logHooks: {
        warn: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      } as unknown as ReturnType<typeof createSubsystemLogger>,
      dispatchWakeHook,
      dispatchAgentHook,
    });
    const req = createRequest();
    const { res, end } = createResponse();

    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(408);
    expect(end).toHaveBeenCalledWith(JSON.stringify({ ok: false, error: "request body timeout" }));
    expect(dispatchWakeHook).not.toHaveBeenCalled();
    expect(dispatchAgentHook).not.toHaveBeenCalled();
  });
});
