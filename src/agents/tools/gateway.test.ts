import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../gateway/server-methods/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import {
  callGatewayTool,
  readGatewayCallOptions,
  resolveGatewayOptions,
  resolveMessageActionAgentRuntimeIdentityToken,
} from "./gateway.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn<(options: CallGatewayOptions) => Promise<unknown>>(),
  handleGatewayRequest: vi.fn<(options: GatewayRequestOptions) => Promise<void>>(),
  config: {} as Record<string, unknown>,
  deviceIdentity: { deviceId: "device", publicKeyPem: "public", privateKeyPem: "private" },
  missingDevice: false,
  deviceIdentityError: undefined as Error | undefined,
}));
vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => mocks.config,
  resolveGatewayPort: () => 18789,
}));
vi.mock("../../gateway/call.js", () => ({ callGateway: mocks.callGateway }));
vi.mock("../../gateway/server-methods.js", () => ({
  handleGatewayRequest: mocks.handleGatewayRequest,
}));
vi.mock("../../infra/device-identity-async.js", () => ({
  loadDeviceIdentityIfPresentAsync: async () => (mocks.missingDevice ? null : mocks.deviceIdentity),
  loadOrCreateDeviceIdentityAsync: async () => {
    if (mocks.deviceIdentityError) {
      throw mocks.deviceIdentityError;
    }
    return mocks.deviceIdentity;
  },
}));

const authorities: AgentRunDelegatedAuthority[] = [];
const caller = { agentId: "ops", sessionKey: "agent:ops:main" };
const source = {
  turnSourceChannel: "telegram",
  turnSourceTo: "chat:123",
  turnSourceAccountId: "work",
  turnSourceThreadId: 42,
};
const nodeParams = { nodeId: "node", command: "device.info", idempotencyKey: "invoke" };
const approvalParams = { id: "approval-id", decision: "allow-once" };
const invokeNode = () => callGatewayTool("node.invoke", {}, nodeParams);
const invokeSystemRun = (
  params: Record<string, unknown>,
  extra?: Parameters<typeof callGatewayTool>[3],
) => callGatewayTool("node.invoke", {}, { ...nodeParams, command: "system.run", params }, extra);
const waitForApproval = (opts: Parameters<typeof callGatewayTool>[1] = {}) =>
  callGatewayTool("exec.approval.waitDecision", opts, approvalParams);
function capturedGatewayCall() {
  expect(mocks.callGateway).toHaveBeenCalledTimes(1);
  return expectDefined(mocks.callGateway.mock.calls[0]?.[0], "Gateway request");
}
function capturedHostedCall() {
  expect(mocks.callGateway).not.toHaveBeenCalled();
  expect(mocks.handleGatewayRequest).toHaveBeenCalledTimes(1);
  return expectDefined(mocks.handleGatewayRequest.mock.calls[0]?.[0], "hosted Gateway request");
}
function runAsCaller<T>(run: () => Promise<T>, localEmbedded = false) {
  const operationalRunInstance = createOperationalRunInstanceRef("run-gateway-tool-test");
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  authorities.push(authority);
  const context = {
    getRuntimeConfig: () => mocks.config,
    trackExecution: (work: () => Promise<void>) => work(),
    ...(localEmbedded ? { localEmbedded: true } : {}),
  } as GatewayRequestContext;
  return withGatewayToolCallerIdentity(
    {
      ...caller,
      ...source,
      operationalRunInstance,
      gatewayContextResolver: () => context,
      receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
    },
    run,
  );
}
function schemaError(dispatched?: boolean) {
  return new GatewayClientRequestError({
    code: "INVALID_REQUEST",
    message: "invalid node.invoke params: at root: unexpected property 'turnSourceChannel'",
    details: dispatched === undefined ? undefined : { nodeCommandDispatched: dispatched },
  });
}

function releaseAuthorities() {
  for (const authority of authorities.splice(0)) {
    releaseAgentRunDelegatedAuthority(authority);
  }
}

describe("gateway tool defaults", () => {
  beforeEach(() => {
    releaseAuthorities();
    mocks.callGateway.mockReset().mockResolvedValue({ ok: true });
    mocks.handleGatewayRequest
      .mockReset()
      .mockImplementation(async ({ respond }) => respond(true, { ok: true }));
    mocks.deviceIdentityError = undefined;
    mocks.missingDevice = false;
    mocks.config = {};
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
    vi.stubEnv("OPENCLAW_GATEWAY_URL", undefined);
  });
  afterAll(() => {
    releaseAuthorities();
    vi.unstubAllEnvs();
  });

  it("rejects invalid timeouts", () => {
    expect(() => readGatewayCallOptions({ timeoutMs: -1 })).toThrow(
      "timeoutMs must be a positive integer",
    );
  });

  it("parses allowlisted RPC options and scopes", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "fallback-token");
    await callGatewayTool(
      "health",
      readGatewayCallOptions({
        gatewayUrl: "ws://127.0.0.1:18789",
        gatewayToken: "t",
        timeoutMs: "5000",
      }),
      {},
    );
    expect(capturedGatewayCall()).toMatchObject({
      method: "health",
      params: {},
      url: "ws://127.0.0.1:18789",
      token: "t",
      timeoutMs: 5000,
      scopes: ["operator.read"],
    });
  });

  it("does not leak local credentials to remote overrides", () => {
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "local-env-token");
    mocks.config = {
      gateway: { auth: { token: "local-config-token" }, remote: { url: "wss://gateway.example" } },
    };
    expect(resolveGatewayOptions({ gatewayUrl: "wss://gateway.example" }).token).toBeUndefined();
  });

  it.each(["system.run", "device.apps.launch"])(
    "replays %s approvals with the persisted device",
    async (command) => {
      mocks.deviceIdentityError = new Error("must not create identity during replay");
      const execution = { approvalDecision: "allow-once", runId: "approval-async" };
      await callGatewayTool(
        "node.invoke",
        {},
        { ...nodeParams, command, params: command === "system.run" ? execution : { execution } },
        {
          scopes: ["operator.write", "operator.approvals"],
        },
      );
      const call = capturedGatewayCall();
      expect(call.deviceIdentity).toEqual(mocks.deviceIdentity);
      expect(call.scopes).toEqual(["operator.write", "operator.approvals"]);
      expect(call).not.toHaveProperty("approvalRuntimeToken");
    },
  );

  it("keeps unapproved node runs device-less", async () => {
    await invokeSystemRun({ approved: false });
    const call = capturedGatewayCall();
    expect(call).not.toHaveProperty("deviceIdentity");
    expect(call).not.toHaveProperty("approvalRuntimeToken");
  });

  it("fails approval replay closed without a persisted device", async () => {
    mocks.missingDevice = true;
    await expect(
      invokeSystemRun(
        { approved: true, runId: "approval-id" },
        {
          scopes: ["operator.write", "operator.approvals"],
        },
      ),
    ).rejects.toThrow("approved node gateway calls require a stable device identity");
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("omits message action authority for untrusted destinations", async () => {
    await runAsCaller(async () => {
      const params = { turnCapability: "unused", runId: "run-1", sessionId: "session-1" };
      expect(
        await resolveMessageActionAgentRuntimeIdentityToken({
          ...params,
          opts: {},
          target: "remote",
        }),
      ).toBeUndefined();
      expect(
        await resolveMessageActionAgentRuntimeIdentityToken({
          ...params,
          opts: { gatewayToken: "explicit" },
          target: "local",
        }),
      ).toBeUndefined();
    });
  });

  it.each([
    "invalid connect params: at /auth: unexpected property 'agentRuntimeIdentityToken'",
    "gateway rejected required agent runtime identity auth field; refusing to retry without it",
  ])("fails stale Gateway identity authentication closed: %s", async (message) => {
    mocks.callGateway.mockRejectedValueOnce(new Error(message));
    await expect(
      runAsCaller(() => callGatewayTool("cron.remove", {}, { id: "job-1" }), true),
    ).rejects.toThrow(
      "The running Gateway is from an older OpenClaw build and rejected current agent runtime connection metadata. Restart the Gateway with `openclaw gateway restart`, then retry.",
    );
    expect(capturedGatewayCall().agentRuntimeIdentityToken).toEqual(expect.any(String));
  });

  it("pins hosted cron calls to their local Gateway", async () => {
    mocks.config = {
      gateway: {
        mode: "remote",
        auth: { mode: "token", token: "local-token" },
        remote: { url: "wss://gateway.example", token: "remote-token" },
      },
    };
    vi.stubEnv("OPENCLAW_GATEWAY_URL", "wss://env.example");
    mocks.handleGatewayRequest.mockImplementationOnce(async ({ respond }) =>
      respond(true, { removed: true }),
    );
    await expect(
      runAsCaller(() => callGatewayTool("cron.remove", {}, { id: "job-1" })),
    ).resolves.toEqual({ removed: true });
    const call = capturedHostedCall();
    expect(call.req).toMatchObject({ method: "cron.remove", params: { id: "job-1" } });
    expect(call.context.getRuntimeConfig()).toBe(mocks.config);
    expect(call.client?.connect.scopes).toEqual(["operator.admin"]);
    expect(call.client?.internal?.agentRuntimeIdentity).toMatchObject(caller);
    expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
  });

  it("overrides forged node provenance", async () => {
    const params = { ...nodeParams, command: "file.fetch", params: { path: "/tmp/a" } };
    await runAsCaller(() =>
      callGatewayTool(
        "node.invoke",
        {},
        {
          ...params,
          turnSourceChannel: "attacker-channel",
          turnSourceTo: "attacker-target",
          turnSourceAccountId: "attacker-account",
          turnSourceThreadId: "attacker-thread",
        },
      ),
    );
    const call = capturedHostedCall();
    expect(call.req.params).toEqual({ ...params, ...source });
    expect(call.client?.internal?.agentRuntimeIdentity).toMatchObject(caller);
  });

  it("retries stale node identity without provenance", async () => {
    mocks.callGateway.mockRejectedValueOnce(
      new Error(
        "invalid connect params: at /auth: unexpected property 'agentRuntimeIdentityToken'",
      ),
    );
    await runAsCaller(invokeNode, true);
    expect(mocks.callGateway).toHaveBeenCalledTimes(2);
    expect(mocks.callGateway.mock.calls[0]?.[0].agentRuntimeIdentityToken).toEqual(
      expect.any(String),
    );
    expect(mocks.callGateway.mock.calls[1]?.[0].agentRuntimeIdentityToken).toBeUndefined();
    expect(mocks.callGateway.mock.calls[1]?.[0].params).toEqual(nodeParams);
  });

  it("retains identity on a node schema retry", async () => {
    mocks.callGateway.mockRejectedValueOnce(schemaError(false));
    await runAsCaller(invokeNode, true);
    expect(mocks.callGateway).toHaveBeenCalledTimes(2);
    expect(mocks.callGateway.mock.calls[1]?.[0].params).toEqual(nodeParams);
    expect(mocks.callGateway.mock.calls[1]?.[0].agentRuntimeIdentityToken).toEqual(
      expect.any(String),
    );
  });

  it.each(["preparation", "retry"])("checks dispatch authority after %s", async (stage) => {
    let current = true;
    const refused = new Error("source closed");
    const sent: unknown[] = [];
    const assertCurrent = vi.fn(() => {
      if (!current) {
        throw refused;
      }
    });
    mocks.callGateway.mockImplementation(async (options) => {
      options.assertDispatchCurrent?.();
      sent.push(options.params);
      current = false;
      throw schemaError(false);
    });
    const result = callGatewayTool("node.invoke", {}, nodeParams, {
      dispatchAuthority: { version: 2, kind: "source-bound", assertCurrent },
    });
    if (stage === "preparation") {
      current = false;
    }
    await expect(result).rejects.toBe(refused);
    expect(assertCurrent).toHaveBeenCalledTimes(stage === "preparation" ? 1 : 2);
    expect(sent).toEqual(stage === "preparation" ? [] : [nodeParams]);
  });

  it.each([true, undefined])(
    "requires pre-dispatch proof for node retries: %s",
    async (dispatched) => {
      const error = schemaError(dispatched);
      mocks.callGateway.mockRejectedValueOnce(error);
      await expect(runAsCaller(invokeNode, true)).rejects.toBe(error);
      expect(mocks.callGateway).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "attaches resolution identity only when required: %s",
    async (required) => {
      await runAsCaller(() =>
        callGatewayTool("exec.approval.resolve", {}, approvalParams, {
          requireAgentRuntimeIdentity: required,
        }),
      );
      const call = capturedHostedCall();
      expect(call.client?.connect.scopes).toEqual(["operator.approvals"]);
      if (required) {
        expect(call.client?.internal?.agentRuntimeIdentity).toMatchObject(caller);
      } else {
        expect(call.client?.internal).not.toHaveProperty("agentRuntimeIdentity");
      }
    },
  );

  it("uses unpaired local approval authority", async () => {
    mocks.config = { gateway: { mode: "remote" } };
    mocks.deviceIdentityError = new Error("state directory read-only");
    await waitForApproval();
    const call = capturedGatewayCall();
    expect(call.approvalRuntimeToken).toEqual(expect.any(String));
    expect(call.scopes).toEqual(["operator.approvals"]);
    expect(call).not.toHaveProperty("deviceIdentity");
  });

  it("binds remote approvals to the requester", async () => {
    mocks.config = {
      gateway: { mode: "remote", remote: { url: "wss://gateway.example", token: "remote-token" } },
    };
    await waitForApproval();
    const call = capturedGatewayCall();
    expect(call.url).toBeUndefined();
    expect(call.token).toBeUndefined();
    expect(call).not.toHaveProperty("approvalRuntimeToken");
    expect(call.deviceIdentity).toEqual(mocks.deviceIdentity);
  });

  it("does not trust environment-selected loopback", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_URL", "ws://127.0.0.1:18789");
    await waitForApproval();
    const call = capturedGatewayCall();
    expect(call.url).toBeUndefined();
    expect(call).not.toHaveProperty("approvalRuntimeToken");
    expect(call.deviceIdentity).toEqual(mocks.deviceIdentity);
  });

  it("fails remote approvals without a device", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_URL", "ws://127.0.0.1:18789");
    mocks.deviceIdentityError = new Error("state directory read-only");
    await expect(waitForApproval()).rejects.toThrow(
      "remote approval gateway calls require a stable device identity",
    );
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("does not send local approval authority to explicit URL overrides", async () => {
    await waitForApproval({ gatewayUrl: "ws://127.0.0.1:18789", gatewayToken: "t" });
    const call = capturedGatewayCall();
    expect(call.url).toBe("ws://127.0.0.1:18789");
    expect(call).not.toHaveProperty("approvalRuntimeToken");
  });

  it("rejects non-allowlisted addresses and loopback ports before RPC", async () => {
    await expect(
      callGatewayTool("health", { gatewayUrl: "ws://127.0.0.1:8080", gatewayToken: "t" }, {}),
    ).rejects.toThrow(/gatewayUrl override rejected/i);
    await expect(
      callGatewayTool("health", { gatewayUrl: "ws://169.254.169.254", gatewayToken: "t" }, {}),
    ).rejects.toThrow(/gatewayUrl override rejected/i);
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });
});
