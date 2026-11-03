import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState } from "../config/config.js";
import type {
  GatewayRequestHandlers,
  GatewayRequestHandlerOptions as Request,
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
const initialTransport = { ...ownerTransport };
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

async function inGateway<T>(run: () => T | Promise<T>): Promise<T> {
  ownerTransport.gatewayContext = true;
  try {
    return await run();
  } finally {
    ownerTransport.gatewayContext = false;
  }
}

export function useLocalStateOwnerFixture(initialHandlers: GatewayRequestHandlers = {}) {
  const roots = useAutoCleanupTempDirTracker(afterEach);
  const disposers: Array<() => void | Promise<void>> = [];
  let owner: GatewayLockHandle | null = null;
  async function invoke(method: string, params: Request["params"], scopes = ["operator.admin"]) {
    const handler = fixture.handlers[method];
    if (!handler) {
      throw new Error(`Missing handler: ${method}`);
    }
    const response: { value?: unknown; error?: unknown } = {};
    await inGateway(() =>
      handler({
        req: { type: "req", id: "fixture", method, params },
        params,
        client: { connect: { scopes } } as Request["client"],
        isWebchatConnect: () => false,
        context: { getRuntimeConfig: () => fixture.config } as Request["context"],
        hasCurrentClientAuthority: () => ownerTransport.current,
        sessionMutationCommitGuard: () => {
          if (!ownerTransport.current) {
            throw new Error("fixture authority revoked");
          }
        },
        respond: (ok, value, error) => {
          Object.assign(response, ok ? { value } : { error });
        },
      }),
    );
    if (response.error) {
      throw new Error(JSON.stringify(response.error));
    }
    return response.value;
  }
  async function dispatch(options: {
    method: string;
    params: Record<string, unknown>;
    scopes: string[];
    assertDispatchCurrent(): void;
  }) {
    options.assertDispatchCurrent();
    if (ownerTransport.revokeBeforeMutation) {
      ownerTransport.current = false;
    }
    const result = await invoke(options.method, options.params, options.scopes);
    if (ownerTransport.failReply) {
      throw new Error("synthetic connection lost after acceptance");
    }
    return result;
  }
  beforeEach(async () => {
    const root = roots.make("openclaw-cli-state-owner-");
    const stateDir = path.join(root, "state");
    await fs.mkdir(stateDir);
    const configPath = path.join(root, "openclaw.json");
    fixture.config = { gateway: { mode: "local", port: 18789 } };
    await fs.writeFile(configPath, JSON.stringify(fixture.config));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
    resetConfigRuntimeState();
    fixture.handlers = { ...initialHandlers };
    Object.assign(ownerTransport, initialTransport);
    ownerTransport.request.mockReset().mockImplementation(dispatch);
    fixture.output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      fixture.output += String(chunk);
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
  const fixture = {
    transport: ownerTransport,
    roots,
    handlers: { ...initialHandlers },
    disposers,
    invoke,
    output: "",
    config: { gateway: { mode: "local" as const, port: 18789 } },
    async startOwner(this: void) {
      owner = await inGateway(() =>
        acquireGatewayLock({ env: process.env, port: 18789, allowInTests: true, timeoutMs: 0 }),
      );
      expect(owner).not.toBeNull();
    },
  };
  return fixture;
}
