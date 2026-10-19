import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushTestResult } from "../../packages/gateway-protocol/src/index.js";
import {
  createNodesProgram,
  gatewayRequests,
  getRuntimeOutput,
  mockGateway,
  type GatewayCallRequest,
} from "./program.nodes-cli-test-support.js";
import { createIosNodeListResponse } from "./program.nodes-test-helpers.js";
import { programGatewayCallMock, runtime } from "./program.test-mocks.js";

let registerNodesCli: typeof import("./nodes-cli.js").registerNodesCli;
let program: Command;
beforeEach(async () => {
  vi.clearAllMocks();
  ({ registerNodesCli } = await import("./nodes-cli.js"));
  program = await createNodesProgram(registerNodesCli);
});

const pairingScopes = ["operator.read", "operator.pairing"];
function nodeResponse(nodeId: string, displayName: string, extra = {}) {
  return { nodes: [{ nodeId, displayName, paired: true, connected: false, ...extra }] };
}
function gatewayError(message: string, name: string, extra = {}) {
  return Object.assign(new Error(message), { name, ...extra });
}
function requestError(message: string, code: string, detailsCode: string, extra = {}) {
  return gatewayError(message, "GatewayClientRequestError", {
    gatewayCode: code,
    details: { code: detailsCode, ...extra },
  });
}
function expectBackendRequest(request: GatewayCallRequest | undefined) {
  expect(request).toMatchObject({
    scopes: pairingScopes,
    clientName: "gateway-client",
    mode: "backend",
    requireLocalBackendSharedAuth: true,
  });
}
function pushResult(overrides: Partial<PushTestResult> = {}): PushTestResult {
  return {
    ok: true,
    status: 200,
    tokenSuffix: "1234abcd",
    topic: "ai.openclaw.ios",
    environment: "sandbox",
    transport: "direct",
    ...overrides,
  };
}

describe("cli program (nodes diagnostics auth)", () => {
  async function runProgram(argv: string[]) {
    runtime.log.mockClear();
    await program.parseAsync(argv, { from: "user" });
  }

  it.each([
    {
      label: "unavailable pairing diagnostics",
      argv: [],
      displayName: "Read Only Node",
      local: true,
      storedError: gatewayError(
        "stored device auth unavailable",
        "GatewayCredentialsRequiredError",
      ),
      backendError: requestError(
        "unauthorized: pairing scope unavailable",
        "INVALID_REQUEST",
        "AUTH_SCOPE_MISMATCH",
      ),
      response: {
        ts: Date.now(),
        ...nodeResponse("read-only-node", "Read Only Node", { approvalState: "approved" }),
      },
    },
    {
      label: "remote explicit credentials",
      argv: ["--url", "wss://gateway.example.test", "--token", "explicit-token"],
      displayName: "Remote Read Only Node",
      local: false,
      storedError: gatewayError(
        "stored device auth disabled for explicit credentials",
        "GatewayStoredDeviceAuthUnavailableError",
      ),
      backendError: gatewayError(
        "local backend shared auth unavailable for remote target",
        "GatewayLocalBackendSharedAuthUnavailableError",
      ),
      response: nodeResponse("remote-read-only-node", "Remote Read Only Node"),
    },
  ])("falls back to read-only status with $label", async (fixture) => {
    mockGateway((opts) => {
      if (opts.method === "node.list") {
        if (opts.useStoredDeviceAuth) {
          throw fixture.storedError;
        }
        const backend = fixture.local
          ? opts.scopes?.includes("operator.pairing")
          : opts.requireLocalBackendSharedAuth;
        if (backend) {
          throw fixture.backendError;
        }
        return fixture.response;
      }
      return fixture.local ? { ok: true } : fixture.response;
    });
    await runProgram(["nodes", "status", ...fixture.argv]);
    const requests = gatewayRequests().filter((request) => request.method === "node.list");
    expect(requests).toHaveLength(3);
    expect(requests[0]?.useStoredDeviceAuth).toBe(true);
    expect(requests[0]?.requiredStoredDeviceAuthScopes).toEqual(pairingScopes);
    expectBackendRequest(requests[1]);
    expect(requests[2]?.useStoredDeviceAuth).toBeUndefined();
    expect(requests[2]?.scopes).toBeUndefined();
    expect(getRuntimeOutput()).toContain(fixture.displayName);
  });

  it("lets missing credentials reach the shared renderer without a nodes status prefix", async () => {
    const error = gatewayError(
      [
        "gateway node.list requires credentials before opening a websocket",
        "Fix: configure gateway.auth token/password, pair this device, or pass --token/--password.",
        "Config: /tmp/openclaw.json",
      ].join("\n"),
      "GatewayCredentialsRequiredError",
      {
        method: "node.list",
        configPath: "/tmp/openclaw.json",
      },
    );
    programGatewayCallMock.mockRejectedValue(error);

    await expect(runProgram(["nodes", "status"])).rejects.toBe(error);

    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it.each([
    new Error("connect ECONNREFUSED 127.0.0.1:4242"),
    requestError("unauthorized: token mismatch", "INVALID_REQUEST", "AUTH_TOKEN_MISMATCH"),
  ])("keeps non-credential node failures distinct: $message", async (error) => {
    programGatewayCallMock.mockRejectedValue(error);

    await expect(runProgram(["nodes", "status"])).rejects.toThrow("exit");

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(error.message));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("nodes status failed:"));
    expect(runtime.error).not.toHaveBeenCalledWith(
      expect.stringContaining("configure gateway.auth"),
    );
    if (error.name === "Error") {
      const requests = gatewayRequests().filter((request) => request.method === "node.list");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.useStoredDeviceAuth).toBe(true);
    }
  });

  it.each([
    {
      label: "rejected stored token",
      error: requestError(
        "unauthorized: device token mismatch",
        "INVALID_REQUEST",
        "AUTH_DEVICE_TOKEN_MISMATCH",
      ),
      backendOnly: false,
    },
    {
      label: "missing stored read scope",
      error: requestError("permission denied", "FORBIDDEN", "MISSING_SCOPE", {
        missingScope: "operator.read",
        requiredScopes: ["operator.read"],
      }),
      backendOnly: true,
    },
  ])("falls back to configured auth for $label", async ({ error, backendOnly }) => {
    mockGateway((opts) => {
      if (opts.method === "node.list" && opts.useStoredDeviceAuth) {
        throw error;
      }
      if (
        opts.method === "node.list" &&
        (!backendOnly || opts.scopes?.includes("operator.pairing"))
      ) {
        return nodeResponse("auth-node", "Auth Node");
      }
      return backendOnly ? { nodes: [] } : { ok: true };
    });

    await runProgram(["nodes", "status"]);

    const requests = gatewayRequests().filter((request) => request.method === "node.list");
    expect(requests).toHaveLength(2);
    if (backendOnly) {
      expectBackendRequest(requests[1]);
    } else {
      expect(requests[0]?.useStoredDeviceAuth).toBe(true);
      expect(requests[1]?.useStoredDeviceAuth).toBeUndefined();
    }
    expect(getRuntimeOutput()).toContain("Auth Node");
  });

  it.each([
    { label: "unfiltered", argv: ["nodes", "list"] },
    { label: "filtered", argv: ["nodes", "list", "--connected"] },
  ])("reads the $label nodes list through node diagnostics auth", async ({ argv }) => {
    mockGateway((opts) => {
      if (opts.method === "node.pair.list") {
        return { pending: [], paired: [{ nodeId: "live-node", displayName: "Stale paired name" }] };
      }
      if (opts.method === "node.list" && opts.useStoredDeviceAuth) {
        throw gatewayError("stored device auth unavailable", "GatewayCredentialsRequiredError");
      }
      if (opts.method === "node.list" && opts.requireLocalBackendSharedAuth) {
        return { nodes: [{ nodeId: "live-node", displayName: "Live Node", connected: true }] };
      }
      if (opts.method === "node.list") {
        // A plain CLI read is capped by the operator device pairing scopes.
        throw requestError("scope upgrade pending approval", "NOT_PAIRED", "PAIRING_REQUIRED");
      }
      return { ok: true };
    });

    await runProgram(argv);

    const listRequest = gatewayRequests().find(
      (request) => request.method === "node.list" && request.requireLocalBackendSharedAuth === true,
    );
    expect(listRequest?.scopes).toEqual(["operator.read", "operator.pairing"]);
    expect(getRuntimeOutput()).toContain("Live Node");
  });
});

describe("cli program (nodes push)", () => {
  let previousExitCode: NodeJS.Process["exitCode"];
  let previousArgv: string[];

  function mockPushResult(result: PushTestResult) {
    mockGateway({ "node.list": createIosNodeListResponse(), "push.test": result });
  }

  async function runPush(extraArgs: string[] = []) {
    process.argv = ["node", "openclaw", "nodes", "push", "--node", "ios-node", ...extraArgs];
    await program.parseAsync(process.argv);
  }

  beforeEach(() => {
    previousExitCode = process.exitCode;
    previousArgv = process.argv;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
    process.argv = previousArgv;
  });

  it.each([
    { environment: "", json: false },
    { environment: "staging", json: true },
  ])(
    "rejects environment $environment before lookup (JSON: $json)",
    async ({ environment, json }) => {
      mockPushResult(pushResult());
      const invalidEnvironment = "invalid --environment (use sandbox|production)";
      await expect(
        runPush(["--environment", environment, ...(json ? ["--json"] : [])]),
      ).rejects.toThrow(json ? invalidEnvironment : "exit");
      expect(programGatewayCallMock).not.toHaveBeenCalled();
      expect(getRuntimeOutput()).toBe("");
      if (json) {
        expect(runtime.error).not.toHaveBeenCalled();
        expect(runtime.exit).not.toHaveBeenCalled();
      } else {
        expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining(`nodes push failed: ${invalidEnvironment}`),
        );
        expect(runtime.exit).toHaveBeenCalledWith(1);
      }
    },
  );

  it("sets a failing exit code after rendering an APNs push failure", async () => {
    mockPushResult(pushResult({ ok: false, status: 400, reason: "BadDeviceToken" }));

    await runPush();

    expect(process.exitCode).toBe(1);
    expect(getRuntimeOutput()).toContain("push.test status=400 ok=false env=sandbox");
    expect(getRuntimeOutput()).toContain("reason: BadDeviceToken");
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("preserves parseable JSON before setting a failing APNs push exit code", async () => {
    const result = pushResult({
      ok: false,
      status: 410,
      reason: "Unregistered",
      environment: "production",
      transport: "relay",
    });
    mockPushResult(result);

    await runPush(["--json"]);

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(getRuntimeOutput())).toEqual(result);
    expect(runtime.writeJson).toHaveBeenCalledWith(result);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it.each([
    { label: "sandbox", extraArgs: ["--environment", " SaNdBoX "], environment: "sandbox" },
    { label: "production", extraArgs: ["--environment", "PrOdUcTiOn"], environment: "production" },
    {
      label: "explicit copy",
      extraArgs: ["--title", " Proof ", "--body", " Body ", "--json"],
      environment: undefined,
      title: "Proof",
      body: "Body",
    },
    {
      label: "blank copy",
      extraArgs: ["--title", " \t ", "--body", "", "--json"],
      environment: undefined,
    },
  ])(
    "keeps successful APNs push $label output at exit zero",
    async ({
      extraArgs,
      environment,
      title = "OpenClaw",
      body = "Push test for node ios-node",
    }) => {
      const result = pushResult({ apnsId: "apns-id" });
      mockPushResult(result);

      await runPush(extraArgs);

      expect(process.exitCode).toBeUndefined();
      const pushRequest = programGatewayCallMock.mock.calls
        .map(([request]) => request as { method?: string; params?: unknown })
        .find(({ method }) => method === "push.test");
      expect(pushRequest?.params).toEqual({
        nodeId: "ios-node",
        title,
        body,
        ...(environment ? { environment } : {}),
      });
      if (extraArgs.includes("--json")) {
        expect(JSON.parse(getRuntimeOutput())).toEqual(result);
      } else {
        expect(getRuntimeOutput()).toContain("push.test status=200 ok=true env=sandbox");
      }
      expect(runtime.exit).not.toHaveBeenCalled();
    },
  );
});
