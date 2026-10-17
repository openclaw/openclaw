// Node diagnostics authentication and push outcomes through the CLI program.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushTestResult } from "../../packages/gateway-protocol/src/index.js";
import {
  createIosNodeListResponse,
  formatRuntimeLogCallArg,
} from "./program.nodes-test-helpers.js";
import { programGatewayCallMock, runtime } from "./program.test-mocks.js";

let registerNodesCli: typeof import("./nodes-cli.js").registerNodesCli;

type GatewayCallRequest = {
  clientName?: string;
  method?: string;
  mode?: string;
  scopes?: string[];
  useStoredDeviceAuth?: boolean;
  requiredStoredDeviceAuthScopes?: unknown;
  requireLocalBackendSharedAuth?: boolean;
};

const pairingScopes = ["operator.read", "operator.pairing"];
function mockGateway(reply: (request: GatewayCallRequest) => unknown) {
  programGatewayCallMock.mockImplementation(async (...args: unknown[]) =>
    reply((args[0] ?? {}) as GatewayCallRequest),
  );
}
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
  let program: Command;

  async function runProgram(argv: string[]) {
    runtime.log.mockClear();
    await program.parseAsync(argv, { from: "user" });
  }

  function getRuntimeOutput() {
    return runtime.log.mock.calls.map((call) => formatRuntimeLogCallArg(call[0])).join("\n");
  }

  function gatewayRequests(): GatewayCallRequest[] {
    return programGatewayCallMock.mock.calls.map(([request]) => request as GatewayCallRequest);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ registerNodesCli } = await import("./nodes-cli.js"));
    program = new Command();
    program.exitOverride();
    await registerNodesCli(program);
  });

  it("falls back to read-only node status when pairing diagnostics are unavailable", async () => {
    mockGateway((opts) => {
      if (opts.method === "node.list" && opts.useStoredDeviceAuth) {
        throw gatewayError("stored device auth unavailable", "GatewayCredentialsRequiredError");
      }
      if (opts.method === "node.list" && opts.scopes?.includes("operator.pairing")) {
        throw requestError(
          "unauthorized: pairing scope unavailable",
          "INVALID_REQUEST",
          "AUTH_SCOPE_MISMATCH",
        );
      }
      if (opts.method === "node.list") {
        return {
          ts: Date.now(),
          ...nodeResponse("read-only-node", "Read Only Node", { approvalState: "approved" }),
        };
      }
      return { ok: true };
    });

    await runProgram(["nodes", "status"]);

    const requests = gatewayRequests().filter((request) => request.method === "node.list");
    expect(requests).toHaveLength(3);
    expect(requests[0]?.useStoredDeviceAuth).toBe(true);
    expect(requests[0]?.requiredStoredDeviceAuthScopes).toEqual(pairingScopes);
    expectBackendRequest(requests[1]);
    expect(requests[2]?.useStoredDeviceAuth).toBeUndefined();
    expect(requests[2]?.scopes).toBeUndefined();
    expect(getRuntimeOutput()).toContain("Read Only Node");
  });

  it("keeps remote explicit diagnostic credentials on the read-only path", async () => {
    mockGateway((opts) => {
      if (opts.method === "node.list" && opts.useStoredDeviceAuth) {
        throw gatewayError(
          "stored device auth disabled for explicit credentials",
          "GatewayStoredDeviceAuthUnavailableError",
        );
      }
      if (opts.method === "node.list" && opts.requireLocalBackendSharedAuth) {
        throw gatewayError(
          "local backend shared auth unavailable for remote target",
          "GatewayLocalBackendSharedAuthUnavailableError",
        );
      }
      return nodeResponse("remote-read-only-node", "Remote Read Only Node");
    });

    await runProgram([
      "nodes",
      "status",
      "--url",
      "wss://gateway.example.test",
      "--token",
      "explicit-token",
    ]);

    const requests = gatewayRequests().filter((request) => request.method === "node.list");
    expect(requests).toHaveLength(3);
    expect(requests[0]?.useStoredDeviceAuth).toBe(true);
    expect(requests[0]?.requiredStoredDeviceAuthScopes).toEqual(pairingScopes);
    expectBackendRequest(requests[1]);
    expect(requests[2]?.scopes).toBeUndefined();
    expect(getRuntimeOutput()).toContain("Remote Read Only Node");
  });

  it("lets missing credentials reach the shared renderer without a nodes status prefix", async () => {
    const error = Object.assign(
      new Error(
        [
          "gateway node.list requires credentials before opening a websocket",
          "Fix: configure gateway.auth token/password, pair this device, or pass --token/--password.",
          "Config: /tmp/openclaw.json",
        ].join("\n"),
      ),
      {
        name: "GatewayCredentialsRequiredError",
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

  it("falls back to configured auth after stored device auth is rejected", async () => {
    mockGateway((opts) => {
      if (opts.method === "node.list" && opts.useStoredDeviceAuth) {
        throw requestError(
          "unauthorized: device token mismatch",
          "INVALID_REQUEST",
          "AUTH_DEVICE_TOKEN_MISMATCH",
        );
      }
      if (opts.method === "node.list") {
        return nodeResponse("configured-auth-node", "Configured Auth Node");
      }
      return { ok: true };
    });

    await runProgram(["nodes", "status"]);

    const requests = gatewayRequests().filter((request) => request.method === "node.list");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.useStoredDeviceAuth).toBe(true);
    expect(requests[1]?.useStoredDeviceAuth).toBeUndefined();
    expect(getRuntimeOutput()).toContain("Configured Auth Node");
  });

  it("falls back to configured auth when stored device auth lacks read scope", async () => {
    mockGateway((opts) => {
      if (opts.method === "node.list" && opts.useStoredDeviceAuth) {
        throw requestError("permission denied", "FORBIDDEN", "MISSING_SCOPE", {
          missingScope: "operator.read",
          requiredScopes: ["operator.read"],
        });
      }
      if (opts.method === "node.list" && opts.scopes?.includes("operator.pairing")) {
        return nodeResponse("shared-auth-node", "Shared Auth Node");
      }
      return { nodes: [] };
    });

    await runProgram(["nodes", "status"]);

    const requests = gatewayRequests().filter((request) => request.method === "node.list");
    expect(requests).toHaveLength(2);
    expectBackendRequest(requests[1]);
    expect(getRuntimeOutput()).toContain("Shared Auth Node");
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
  let program: Command;
  let previousExitCode: NodeJS.Process["exitCode"];
  let previousArgv: string[];

  function mockPushResult(result: PushTestResult) {
    mockGateway((opts) => {
      if (opts.method === "node.list") {
        return createIosNodeListResponse();
      }
      if (opts.method === "push.test") {
        return result;
      }
      return { ok: true };
    });
  }

  function runtimeOutput(): string {
    return runtime.log.mock.calls
      .map(([value]) => (typeof value === "string" ? value : (JSON.stringify(value) ?? "")))
      .join("\n");
  }

  async function runPush(extraArgs: string[] = []) {
    process.argv = ["node", "openclaw", "nodes", "push", "--node", "ios-node", ...extraArgs];
    await program.parseAsync(process.argv);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    previousExitCode = process.exitCode;
    previousArgv = process.argv;
    process.exitCode = undefined;
    ({ registerNodesCli } = await import("./nodes-cli.js"));
    program = new Command();
    program.exitOverride();
    await registerNodesCli(program);
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
      expect(runtimeOutput()).toBe("");
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
    expect(runtimeOutput()).toContain("push.test status=400 ok=false env=sandbox");
    expect(runtimeOutput()).toContain("reason: BadDeviceToken");
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
    expect(JSON.parse(runtimeOutput())).toEqual(result);
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
        expect(JSON.parse(runtimeOutput())).toEqual(result);
      } else {
        expect(runtimeOutput()).toContain("push.test status=200 ok=true env=sandbox");
      }
      expect(runtime.exit).not.toHaveBeenCalled();
    },
  );
});
