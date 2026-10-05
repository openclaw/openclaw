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
  scopes?: unknown;
  useStoredDeviceAuth?: boolean;
  requiredStoredDeviceAuthScopes?: unknown;
  requireLocalBackendSharedAuth?: boolean;
};

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
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as {
        method?: string;
        scopes?: string[];
        useStoredDeviceAuth?: boolean;
      };
      if (opts.method === "node.list" && opts.useStoredDeviceAuth) {
        throw Object.assign(new Error("stored device auth unavailable"), {
          name: "GatewayCredentialsRequiredError",
        });
      }
      if (opts.method === "node.list" && opts.scopes?.includes("operator.pairing")) {
        throw Object.assign(new Error("unauthorized: pairing scope unavailable"), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVALID_REQUEST",
          details: { code: "AUTH_SCOPE_MISMATCH" },
        });
      }
      if (opts.method === "node.list") {
        return {
          ts: Date.now(),
          nodes: [
            {
              nodeId: "read-only-node",
              displayName: "Read Only Node",
              approvalState: "approved",
              paired: true,
              connected: false,
            },
          ],
        };
      }
      return { ok: true };
    });

    await runProgram(["nodes", "status"]);

    const requests = gatewayRequests().filter((request) => request.method === "node.list");
    expect(requests).toHaveLength(3);
    expect(requests[0]?.useStoredDeviceAuth).toBe(true);
    expect(requests[0]?.requiredStoredDeviceAuthScopes).toEqual([
      "operator.read",
      "operator.pairing",
    ]);
    expect(requests[1]?.scopes).toEqual(["operator.read", "operator.pairing"]);
    expect(requests[1]?.clientName).toBe("gateway-client");
    expect(requests[1]?.mode).toBe("backend");
    expect(requests[1]?.requireLocalBackendSharedAuth).toBe(true);
    expect(requests[2]?.useStoredDeviceAuth).toBeUndefined();
    expect(requests[2]?.scopes).toBeUndefined();
    expect(getRuntimeOutput()).toContain("Read Only Node");
  });

  it("keeps remote explicit diagnostic credentials on the read-only path", async () => {
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as {
        method?: string;
        requireLocalBackendSharedAuth?: boolean;
        useStoredDeviceAuth?: boolean;
      };
      if (opts.method === "node.list" && opts.useStoredDeviceAuth) {
        throw Object.assign(new Error("stored device auth disabled for explicit credentials"), {
          name: "GatewayStoredDeviceAuthUnavailableError",
        });
      }
      if (opts.method === "node.list" && opts.requireLocalBackendSharedAuth) {
        throw Object.assign(new Error("local backend shared auth unavailable for remote target"), {
          name: "GatewayLocalBackendSharedAuthUnavailableError",
        });
      }
      return {
        nodes: [
          {
            nodeId: "remote-read-only-node",
            displayName: "Remote Read Only Node",
            paired: true,
            connected: false,
          },
        ],
      };
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
    expect(requests[0]?.requiredStoredDeviceAuthScopes).toEqual([
      "operator.read",
      "operator.pairing",
    ]);
    expect(requests[1]?.scopes).toEqual(["operator.read", "operator.pairing"]);
    expect(requests[1]?.clientName).toBe("gateway-client");
    expect(requests[1]?.mode).toBe("backend");
    expect(requests[1]?.requireLocalBackendSharedAuth).toBe(true);
    expect(requests[2]?.scopes).toBeUndefined();
    expect(getRuntimeOutput()).toContain("Remote Read Only Node");
  });

  it("does not retry node diagnostics after a transport failure", async () => {
    programGatewayCallMock.mockRejectedValue(new Error("gateway timed out"));

    await expect(runProgram(["nodes", "status"])).rejects.toThrow("exit");

    const requests = gatewayRequests().filter((request) => request.method === "node.list");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.useStoredDeviceAuth).toBe(true);
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
    Object.assign(new Error("unauthorized: token mismatch"), {
      name: "GatewayClientRequestError",
      gatewayCode: "INVALID_REQUEST",
      details: { code: "AUTH_TOKEN_MISMATCH" },
    }),
  ])("keeps non-credential node failures distinct: $message", async (error) => {
    programGatewayCallMock.mockRejectedValue(error);

    await expect(runProgram(["nodes", "status"])).rejects.toThrow("exit");

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(error.message));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("nodes status failed:"));
    expect(runtime.error).not.toHaveBeenCalledWith(
      expect.stringContaining("configure gateway.auth"),
    );
  });

  it("falls back to configured auth after stored device auth is rejected", async () => {
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string; useStoredDeviceAuth?: boolean };
      if (opts.method === "node.list" && opts.useStoredDeviceAuth) {
        throw Object.assign(new Error("unauthorized: device token mismatch"), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVALID_REQUEST",
          details: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
        });
      }
      if (opts.method === "node.list") {
        return {
          nodes: [
            {
              nodeId: "configured-auth-node",
              displayName: "Configured Auth Node",
              paired: true,
              connected: false,
            },
          ],
        };
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

  it("falls back to configured auth when role policies reject the stored device identity", async () => {
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as {
        method?: string;
        requireLocalBackendSharedAuth?: boolean;
        useStoredDeviceAuth?: boolean;
      };
      if (opts.method === "node.list" && opts.useStoredDeviceAuth) {
        throw Object.assign(
          new Error(
            "operator role policies require a verified user identity for this authentication method",
          ),
          {
            name: "GatewayClientRequestError",
            gatewayCode: "INVALID_REQUEST",
            details: { code: "AUTH_VERIFIED_USER_REQUIRED" },
          },
        );
      }
      if (opts.method === "node.list" && opts.requireLocalBackendSharedAuth) {
        throw Object.assign(new Error("local backend shared auth unavailable for trusted-proxy"), {
          name: "GatewayLocalBackendSharedAuthUnavailableError",
        });
      }
      if (opts.method === "node.list") {
        return {
          nodes: [
            {
              nodeId: "password-auth-node",
              displayName: "Password Auth Node",
              paired: true,
              connected: true,
            },
          ],
        };
      }
      return { ok: true };
    });

    await runProgram(["nodes", "status"]);

    const requests = gatewayRequests().filter((request) => request.method === "node.list");
    expect(requests).toHaveLength(3);
    expect(requests[0]?.useStoredDeviceAuth).toBe(true);
    expect(requests[1]?.requireLocalBackendSharedAuth).toBe(true);
    expect(requests[2]?.useStoredDeviceAuth).toBeUndefined();
    expect(requests[2]?.scopes).toBeUndefined();
    expect(getRuntimeOutput()).toContain("Password Auth Node");
  });

  it("falls back to configured auth when stored device auth lacks read scope", async () => {
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as {
        method?: string;
        scopes?: string[];
        useStoredDeviceAuth?: boolean;
      };
      if (opts.method === "node.list" && opts.useStoredDeviceAuth) {
        throw Object.assign(new Error("permission denied"), {
          name: "GatewayClientRequestError",
          gatewayCode: "FORBIDDEN",
          details: {
            code: "MISSING_SCOPE",
            missingScope: "operator.read",
            requiredScopes: ["operator.read"],
          },
        });
      }
      if (opts.method === "node.list" && opts.scopes?.includes("operator.pairing")) {
        return {
          nodes: [
            {
              nodeId: "shared-auth-node",
              displayName: "Shared Auth Node",
              paired: true,
              connected: false,
            },
          ],
        };
      }
      return { nodes: [] };
    });

    await runProgram(["nodes", "status"]);

    const requests = gatewayRequests().filter((request) => request.method === "node.list");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.scopes).toEqual(["operator.read", "operator.pairing"]);
    expect(requests[1]?.clientName).toBe("gateway-client");
    expect(requests[1]?.mode).toBe("backend");
    expect(requests[1]?.requireLocalBackendSharedAuth).toBe(true);
    expect(getRuntimeOutput()).toContain("Shared Auth Node");
  });

  it.each([
    { label: "unfiltered", argv: ["nodes", "list"] },
    { label: "filtered", argv: ["nodes", "list", "--connected"] },
  ])("reads the $label nodes list through node diagnostics auth", async ({ argv }) => {
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as {
        method?: string;
        requireLocalBackendSharedAuth?: boolean;
        useStoredDeviceAuth?: boolean;
      };
      if (opts.method === "node.pair.list") {
        return { pending: [], paired: [{ nodeId: "live-node", displayName: "Stale paired name" }] };
      }
      if (opts.method === "node.list" && opts.useStoredDeviceAuth) {
        throw Object.assign(new Error("stored device auth unavailable"), {
          name: "GatewayCredentialsRequiredError",
        });
      }
      if (opts.method === "node.list" && opts.requireLocalBackendSharedAuth) {
        return { nodes: [{ nodeId: "live-node", displayName: "Live Node", connected: true }] };
      }
      if (opts.method === "node.list") {
        // A plain CLI read is capped by the operator device pairing scopes.
        throw Object.assign(new Error("scope upgrade pending approval"), {
          name: "GatewayClientRequestError",
          gatewayCode: "NOT_PAIRED",
          details: { code: "PAIRING_REQUIRED" },
        });
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
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
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
      mockPushResult({
        ok: true,
        status: 200,
        tokenSuffix: "1234abcd",
        topic: "ai.openclaw.ios",
        environment: "sandbox",
        transport: "direct",
      });
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
    mockPushResult({
      ok: false,
      status: 400,
      reason: "BadDeviceToken",
      tokenSuffix: "1234abcd",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      transport: "direct",
    });

    await runPush();

    expect(process.exitCode).toBe(1);
    expect(runtimeOutput()).toContain("push.test status=400 ok=false env=sandbox");
    expect(runtimeOutput()).toContain("reason: BadDeviceToken");
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("preserves parseable JSON before setting a failing APNs push exit code", async () => {
    const result: PushTestResult = {
      ok: false,
      status: 410,
      reason: "Unregistered",
      tokenSuffix: "1234abcd",
      topic: "ai.openclaw.ios",
      environment: "production",
      transport: "relay",
    };
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
      const result: PushTestResult = {
        ok: true,
        status: 200,
        apnsId: "apns-id",
        tokenSuffix: "1234abcd",
        topic: "ai.openclaw.ios",
        environment: "sandbox",
        transport: "direct",
      };
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
