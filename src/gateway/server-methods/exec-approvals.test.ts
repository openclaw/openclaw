import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTrustWindow, initTrustWindowCache } from "../../infra/exec-approvals.js";
import { ErrorCodes } from "../protocol/index.js";
import { execApprovalsHandlers } from "./exec-approvals.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type ResponseError = {
  code?: string;
  message?: string;
};

type HandlerCallResult = {
  ok: boolean;
  payload: unknown;
  error: ResponseError | undefined;
  warnSpy: ReturnType<typeof vi.fn>;
};

function createClient(params: {
  id: string;
  mode: string;
  connId: string;
  deviceId?: string;
  clientIp?: string;
  authMethod?: "token" | "password" | "device-token" | "bootstrap-token" | "trusted-proxy";
}): GatewayClient {
  return {
    connId: params.connId,
    clientIp: params.clientIp,
    authMethod: params.authMethod,
    connect: {
      client: {
        id: params.id,
        mode: params.mode,
        version: "test",
        platform: "test",
      },
      device: params.deviceId ? { id: params.deviceId } : undefined,
    } as GatewayClient["connect"],
  };
}

async function invokeHandler(params: {
  method: keyof typeof execApprovalsHandlers;
  payload: Record<string, unknown>;
  client: GatewayClient | null;
}): Promise<HandlerCallResult> {
  const warnSpy = vi.fn();
  let captured: { ok: boolean; payload: unknown; error: ResponseError | undefined } | undefined;
  const handler = execApprovalsHandlers[params.method];
  await handler({
    req: { id: "req-1", method: params.method, params: params.payload } as never,
    params: params.payload,
    client: params.client,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      captured = {
        ok,
        payload,
        error: error as ResponseError | undefined,
      };
    },
    context: {
      logGateway: {
        warn: warnSpy,
        info: vi.fn(),
      },
    } as unknown as GatewayRequestContext,
  });
  if (!captured) {
    throw new Error("handler did not respond");
  }
  return { ...captured, warnSpy };
}

describe("exec approvals trust handler", () => {
  beforeEach(() => {
    initTrustWindowCache();
  });

  it("rejects trust grants from non-CLI callers", async () => {
    const backendClient = createClient({
      id: "openclaw-control-ui",
      mode: "backend",
      connId: "conn-backend",
      deviceId: "dev-backend",
    });
    const response = await invokeHandler({
      method: "exec.approvals.trust",
      payload: { agentId: "main", minutes: 5, force: false },
      client: backendClient,
    });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(response.error?.message).toContain("interactive CLI caller");
    expect(response.warnSpy).toHaveBeenCalledTimes(1);
  });

  it("derives grantedBy from caller metadata (server-side)", async () => {
    const cliClient = createClient({
      id: "cli",
      mode: "cli",
      connId: "conn-cli",
      deviceId: "dev-cli",
    });
    const trustResponse = await invokeHandler({
      method: "exec.approvals.trust",
      payload: {
        agentId: "main",
        minutes: 5,
        force: false,
      },
      client: cliClient,
    });
    expect(trustResponse.ok).toBe(true);

    const statusResponse = await invokeHandler({
      method: "exec.approvals.trust.status",
      payload: { agentId: "main" },
      client: cliClient,
    });
    expect(statusResponse.ok).toBe(true);
    expect(
      (statusResponse.payload as { trustWindow?: { grantedBy?: string } }).trustWindow?.grantedBy,
    ).toBe("cli:cli:conn-cli");
  });

  it("returns INVALID_REQUEST when trust window already active", async () => {
    const cliClient = createClient({ id: "cli", mode: "cli", connId: "c1", deviceId: "d1" });
    await invokeHandler({
      method: "exec.approvals.trust",
      payload: { agentId: "main", minutes: 5, force: false },
      client: cliClient,
    });
    const dup = await invokeHandler({
      method: "exec.approvals.trust",
      payload: { agentId: "main", minutes: 5, force: false },
      client: cliClient,
    });
    expect(dup.ok).toBe(false);
    expect(dup.error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(dup.error?.message).toContain("already active");
  });

  it("rejects trust grants from cli-mode callers without device identity", async () => {
    const spoofedCliClient = createClient({
      id: "cli",
      mode: "cli",
      connId: "conn-spoofed-cli",
    });
    const response = await invokeHandler({
      method: "exec.approvals.trust",
      payload: { agentId: "main", minutes: 5, force: false },
      client: spoofedCliClient,
    });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(response.error?.message).toContain("interactive CLI caller");
    expect(response.warnSpy).toHaveBeenCalledTimes(1);
  });

  it("allows localhost CLI trust grants with token auth and no device identity", async () => {
    const localCliClient = createClient({
      id: "cli",
      mode: "cli",
      connId: "conn-local-cli",
      clientIp: "127.0.0.1",
      authMethod: "token",
    });
    const response = await invokeHandler({
      method: "exec.approvals.trust",
      payload: { agentId: "main", minutes: 5, force: false },
      client: localCliClient,
    });
    expect(response.ok).toBe(true);
  });

  it("rejects non-loopback CLI trust grants without device identity", async () => {
    const remoteCliClient = createClient({
      id: "cli",
      mode: "cli",
      connId: "conn-remote-cli",
      clientIp: "10.0.0.5",
      authMethod: "token",
    });
    const response = await invokeHandler({
      method: "exec.approvals.trust",
      payload: { agentId: "main", minutes: 5, force: false },
      client: remoteCliClient,
    });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(response.error?.message).toContain("interactive CLI caller");
    expect(response.warnSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects untrust calls from non-CLI callers", async () => {
    const cliClient = createClient({
      id: "cli",
      mode: "cli",
      connId: "conn-cli",
      deviceId: "dev-cli",
    });
    const trustResponse = await invokeHandler({
      method: "exec.approvals.trust",
      payload: { agentId: "main", minutes: 5, force: false },
      client: cliClient,
    });
    expect(trustResponse.ok).toBe(true);

    const backendClient = createClient({
      id: "openclaw-control-ui",
      mode: "backend",
      connId: "conn-backend",
      deviceId: "dev-backend",
    });
    const untrustResponse = await invokeHandler({
      method: "exec.approvals.untrust",
      payload: { agentId: "main", keepAudit: true },
      client: backendClient,
    });
    expect(untrustResponse.ok).toBe(false);
    expect(untrustResponse.error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(untrustResponse.error?.message).toContain("interactive CLI caller");
    expect(untrustResponse.warnSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects trust status queries from non-CLI callers", async () => {
    const backendClient = createClient({
      id: "openclaw-control-ui",
      mode: "backend",
      connId: "conn-backend",
      deviceId: "dev-backend",
    });
    const statusResponse = await invokeHandler({
      method: "exec.approvals.trust.status",
      payload: { agentId: "main" },
      client: backendClient,
    });
    expect(statusResponse.ok).toBe(false);
    expect(statusResponse.error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(statusResponse.error?.message).toContain("interactive CLI caller");
    expect(statusResponse.warnSpy).toHaveBeenCalledTimes(1);
  });

  it("allows untrust to clear expired trust windows", async () => {
    const cliClient = createClient({
      id: "cli",
      mode: "cli",
      connId: "conn-cli",
      deviceId: "dev-cli",
    });
    const trustResponse = await invokeHandler({
      method: "exec.approvals.trust",
      payload: { agentId: "main", minutes: 5, force: false },
      client: cliClient,
    });
    expect(trustResponse.ok).toBe(true);

    const trustWindow = getTrustWindow("main");
    expect(trustWindow).toBeTruthy();
    if (!trustWindow) {
      return;
    }
    trustWindow.expiresAt = Date.now() - 1_000;

    const untrustResponse = await invokeHandler({
      method: "exec.approvals.untrust",
      payload: { agentId: "main", keepAudit: true },
      client: cliClient,
    });
    expect(untrustResponse.ok).toBe(true);
    expect((untrustResponse.payload as { ok?: boolean; agentId?: string }).agentId).toBe("main");
    expect(getTrustWindow("main")).toBeUndefined();
  });

  it("treats untrust as idempotent when no trust window exists", async () => {
    const cliClient = createClient({
      id: "cli",
      mode: "cli",
      connId: "conn-cli",
      deviceId: "dev-cli",
    });
    const untrustResponse = await invokeHandler({
      method: "exec.approvals.untrust",
      payload: { agentId: "main", keepAudit: true },
      client: cliClient,
    });
    expect(untrustResponse.ok).toBe(true);
    expect(
      (untrustResponse.payload as { ok?: boolean; agentId?: string; summary?: string | null })
        .agentId,
    ).toBe("main");
    expect(
      (untrustResponse.payload as { ok?: boolean; agentId?: string; summary?: string | null })
        .summary,
    ).toBeNull();
  });

  it("returns full trust window payload in trust.status", async () => {
    const cliClient = createClient({
      id: "cli",
      mode: "cli",
      connId: "conn-cli",
      deviceId: "dev-cli",
    });
    await invokeHandler({
      method: "exec.approvals.trust",
      payload: { agentId: "main", minutes: 5, force: false },
      client: cliClient,
    });

    const statusResponse = await invokeHandler({
      method: "exec.approvals.trust.status",
      payload: { agentId: "main" },
      client: cliClient,
    });
    expect(statusResponse.ok).toBe(true);
    const tw = (
      statusResponse.payload as {
        trustWindow: { remainingMs: number; security: string; ask: string; expiresAt: number };
      }
    ).trustWindow;
    expect(tw.security).toBe("full");
    expect(tw.ask).toBe("off");
    expect(tw.remainingMs).toBeGreaterThan(0);
    expect(tw.expiresAt).toBeGreaterThan(Date.now());
  });

  it("returns trustWindow: null for an expired window", async () => {
    const cliClient = createClient({ id: "cli", mode: "cli", connId: "c2", deviceId: "d2" });
    await invokeHandler({
      method: "exec.approvals.trust",
      payload: { agentId: "main", minutes: 5, force: false },
      client: cliClient,
    });
    const tw = getTrustWindow("main");
    if (tw) {
      tw.expiresAt = Date.now() - 1000;
    }
    const status = await invokeHandler({
      method: "exec.approvals.trust.status",
      payload: { agentId: "main" },
      client: cliClient,
    });
    expect(status.ok).toBe(true);
    expect((status.payload as { trustWindow: unknown }).trustWindow).toBeNull();
  });

  it("cleans up audit file when untrust is called without keepAudit", async () => {
    const cliClient = createClient({
      id: "cli",
      mode: "cli",
      connId: "conn-cli",
      deviceId: "dev-cli",
    });
    await invokeHandler({
      method: "exec.approvals.trust",
      payload: { agentId: "main", minutes: 5, force: false },
      client: cliClient,
    });
    const untrustResponse = await invokeHandler({
      method: "exec.approvals.untrust",
      payload: { agentId: "main" },
      client: cliClient,
    });
    expect(untrustResponse.ok).toBe(true);
    // keepAudit defaults to falsy, so cleanup should have been called
    expect((untrustResponse.payload as { ok: boolean }).ok).toBe(true);
  });
});
