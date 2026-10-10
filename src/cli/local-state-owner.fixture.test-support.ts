import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState } from "../config/config.js";
import type {
  GatewayRequestHandlers,
  GatewayRequestHandlerOptions,
} from "../gateway/server-methods/types.js";
import { acquireGatewayLock, type GatewayLockHandle } from "../infra/gateway-lock.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";

const ownerTransport = vi.hoisted(() => ({
  gatewayContext: false,
  request: vi.fn(),
  failReply: false,
  revokeBeforeMutation: false,
  current: true,
}));
// Model the separate CLI's lack of hosted custody while retaining the real physical owner and writer guards.
vi.mock("../infra/gateway-state-owner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/gateway-state-owner.js")>();
  return {
    ...actual,
    captureGatewayStateOwner: (...args: Parameters<typeof actual.captureGatewayStateOwner>) =>
      ownerTransport.gatewayContext ? actual.captureGatewayStateOwner(...args) : undefined,
  };
});
vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: ownerTransport.request,
}));

export function useLocalStateOwnerFixture(initialHandlers: GatewayRequestHandlers = {}) {
  const roots = useAutoCleanupTempDirTracker(afterEach);
  const disposers: Array<() => void | Promise<void>> = [];
  const handlers: GatewayRequestHandlers = {};
  let owner: GatewayLockHandle | null = null;
  let output = "";
  let config: { gateway: { mode: "local"; port: number } };
  async function invoke(
    method: string,
    params: Record<string, unknown>,
    scopes = ["operator.admin"],
  ) {
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`Missing handler: ${method}`);
    }
    const client = { connect: { scopes } } as GatewayRequestHandlerOptions["client"];
    let value: unknown;
    let error: unknown;
    ownerTransport.gatewayContext = true;
    try {
      await handler({
        req: { type: "req", id: "fixture", method, params },
        params,
        client,
        isWebchatConnect: () => false,
        context: { getRuntimeConfig: () => config } as GatewayRequestHandlerOptions["context"],
        hasCurrentClientAuthority: () => ownerTransport.current,
        sessionMutationCommitGuard: () => {
          if (!ownerTransport.current) {
            throw new Error("fixture authority revoked");
          }
        },
        respond: (ok, result, failure) => {
          if (ok) {
            value = result;
          } else {
            error = failure;
          }
        },
      });
    } finally {
      ownerTransport.gatewayContext = false;
    }
    if (error) {
      throw new Error(JSON.stringify(error));
    }
    return value;
  }
  beforeEach(async () => {
    const root = roots.make("openclaw-cli-state-owner-");
    const stateDir = path.join(root, "state");
    await fs.mkdir(stateDir);
    const configPath = path.join(root, "openclaw.json");
    config = { gateway: { mode: "local", port: 18789 } };
    await fs.writeFile(configPath, JSON.stringify(config));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
    resetConfigRuntimeState();
    for (const key of Object.keys(handlers)) {
      delete handlers[key];
    }
    Object.assign(handlers, initialHandlers);
    Object.assign(ownerTransport, {
      gatewayContext: false,
      current: true,
      failReply: false,
      revokeBeforeMutation: false,
    });
    ownerTransport.request
      .mockReset()
      .mockImplementation(
        async (options: {
          method: string;
          params: Record<string, unknown>;
          scopes: string[];
          prepareDispatchCurrent(): Promise<void>;
          assertDispatchCurrent(): void;
        }) => {
          await options.prepareDispatchCurrent();
          options.assertDispatchCurrent();
          if (ownerTransport.revokeBeforeMutation) {
            ownerTransport.current = false;
          }
          const result = await invoke(options.method, options.params, options.scopes);
          if (ownerTransport.failReply) {
            throw new Error("synthetic connection lost after acceptance");
          }
          return result;
        },
      );
    output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
  });
  afterEach(async () => {
    for (const dispose of disposers.splice(0)) {
      await dispose();
    }
    await closeOpenClawStateDatabaseAsync();
    await owner?.release();
    owner = null;
    resetConfigRuntimeState();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });
  return {
    transport: ownerTransport,
    roots,
    handlers,
    disposers,
    invoke,
    get output() {
      return output;
    },
    get config() {
      return config;
    },
    async startOwner(this: void) {
      ownerTransport.gatewayContext = true;
      try {
        owner = await acquireGatewayLock({
          env: process.env,
          port: 18789,
          allowInTests: true,
          timeoutMs: 0,
        });
      } finally {
        ownerTransport.gatewayContext = false;
      }
      expect(owner).not.toBeNull();
    },
  };
}
