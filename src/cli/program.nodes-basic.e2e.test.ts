// Program nodes basic e2e tests cover node command registration through the full CLI program.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayProtocolRequestTimeoutError } from "../../packages/gateway-client/src/protocol-request.js";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import {
  createIosNodeListResponse,
  formatRuntimeLogCallArg,
} from "./program.nodes-test-helpers.js";
import { programGatewayCallMock, runtime } from "./program.test-mocks.js";

let registerNodesCli: typeof import("./nodes-cli.js").registerNodesCli;

function connectedNode(nodeId: string, displayName: string, details: Record<string, unknown>) {
  return { nodeId, displayName, paired: true, connected: true, ...details };
}
const statusColumns = ["Detail", "Status", "Caps", "camera", "canvas"];

type GatewayCallRequest = {
  clientName?: string;
  method?: string;
  mode?: string;
  params?: unknown;
  scopes?: unknown;
  useStoredDeviceAuth?: boolean;
  requiredStoredDeviceAuthScopes?: unknown;
  requireLocalBackendSharedAuth?: boolean;
};

describe("cli program (nodes basics)", () => {
  let program: Command;

  function mockGateway(responses: Record<string, unknown>) {
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const { method = "" } = (args[0] ?? {}) as GatewayCallRequest;
      const response = responses[method] ?? { ok: true };
      if (response instanceof Error) {
        throw response;
      }
      return response;
    });
  }

  function expectOutput(output: string, included: string[], excluded: string[] = []) {
    for (const value of included) {
      expect(output).toContain(value);
    }
    for (const value of excluded) {
      expect(output).not.toContain(value);
    }
  }

  async function runProgram(argv: string[]) {
    runtime.log.mockClear();
    await program.parseAsync(argv, { from: "user" });
  }

  function getRuntimeOutput() {
    return runtime.log.mock.calls.map((c) => formatRuntimeLogCallArg(c[0])).join("\n");
  }

  function gatewayRequests(): GatewayCallRequest[] {
    return programGatewayCallMock.mock.calls.map(([request]) => request as GatewayCallRequest);
  }

  function writeJsonArgAt(index: number): unknown {
    const call =
      runtime.writeJson.mock.calls[index < 0 ? runtime.writeJson.mock.calls.length + index : index];
    if (!call) {
      throw new Error(`expected writeJson call ${index}`);
    }
    return call[0];
  }

  function expectGatewayRequest(method: string, params?: unknown): void {
    const request = gatewayRequests().find((candidate) => candidate.method === method);
    expect(request?.method).toBe(method);
    if (arguments.length > 1) {
      expect(request?.params).toEqual(params);
    }
  }

  function mockGatewayWithIosNodeListAnd(method: "node.describe" | "node.invoke", result: unknown) {
    mockGateway({ "node.list": createIosNodeListResponse(), [method]: result });
  }

  function mockApproval(pendingDetails: Record<string, unknown>) {
    mockGateway({
      "node.pair.list": {
        pending: [{ requestId: "r1", nodeId: "n1", ts: Date.now(), ...pendingDetails }],
        paired: [],
      },
      "node.pair.approve": { requestId: "r1", node: { nodeId: "n1", token: "t1" } },
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ registerNodesCli } = await import("./nodes-cli.js"));
    program = new Command();
    program.exitOverride();
    await registerNodesCli(program);
  });

  it("runs nodes list with the effective paired node view while preserving paired metadata", async () => {
    const now = Date.now();
    mockGateway({
      "node.pair.list": {
        pending: [{ requestId: "r1", nodeId: "pending-node", ts: now - 10_000 }],
        paired: [
          {
            nodeId: "paired-store",
            displayName: "Stale paired name",
            remoteIp: "10.0.0.1",
            token: "paired-token",
            lastConnectedAtMs: now - 5_000,
          },
          {
            nodeId: "pair-only",
            displayName: "Pair Only",
            token: "pair-only-token",
          },
        ],
      },
      "node.list": {
        nodes: [
          {
            nodeId: "paired-store",
            displayName: "Effective paired name",
            remoteIp: "10.0.0.2",
            connected: true,
            connectedAtMs: now - 1_000,
          },
          {
            nodeId: "catalog-only",
            displayName: "Catalog Only",
            remoteIp: "10.0.0.3",
            paired: true,
            connected: false,
          },
          {
            nodeId: "effective-only-unknown",
            displayName: "Effective Only Unknown",
            connected: true,
          },
          {
            nodeId: "unpaired-live",
            displayName: "Unpaired Live",
            paired: false,
            connected: true,
          },
        ],
      },
    });

    await runProgram(["nodes", "list", "--json"]);

    expectGatewayRequest("node.pair.list", {});
    expectGatewayRequest("node.list", {});
    const json = writeJsonArgAt(0) as {
      pending?: unknown[];
      paired?: Array<Record<string, unknown>>;
    };
    expect(json.pending).toEqual([{ requestId: "r1", nodeId: "pending-node", ts: now - 10_000 }]);
    const fields = [
      "nodeId",
      "displayName",
      "remoteIp",
      "lastConnectedAtMs",
      "connected",
      "paired",
    ];
    expect(json.paired?.map((node) => fields.map((field) => node[field]))).toEqual([
      ["paired-store", "Effective paired name", "10.0.0.2", now - 5_000, true, undefined],
      ["catalog-only", "Catalog Only", "10.0.0.3", undefined, false, true],
      ["pair-only", "Pair Only", undefined, undefined, undefined, undefined],
    ]);
    expectOutput(JSON.stringify(json), [], ["paired-token", "pair-only-token"]);
    const output = getRuntimeOutput();
    expect(output).toMatch(/^\{/);
    expectOutput(output, [], ["Pending: 1 · Paired: 3", "Effective Only Unknown", "unpaired-live"]);
  });

  it("sanitizes untrusted nodes list table fields while preserving JSON values", async () => {
    const now = Date.now();
    mockGateway({
      "node.pair.list": {
        pending: [
          {
            requestId: "request\u001b[2K-1",
            nodeId: "pending-node",
            displayName: "Pending\u001b[1A\nNode",
            remoteIp: "10.0.0.4\rrewritten",
            ts: now - 1_000,
          },
        ],
        paired: [
          {
            nodeId: "paired-node",
            displayName: "Paired\u001b[2K\nNode",
            remoteIp: "10.0.0.5\rrewritten",
          },
        ],
      },
      "node.list": new Error("older gateway"),
    });

    await runProgram(["nodes", "list"]);

    const output = getRuntimeOutput();
    expectOutput(
      output,
      ["Pending\\nNode", "Paired\\nNode", "10.0.0.5\\rrewritten"],
      ["\u001b", "[2K"],
    );
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("live node view unavailable"),
    );
    expect(output).not.toContain("live node view unavailable");

    runtime.log.mockClear();
    await runProgram(["nodes", "list", "--json"]);

    const json = writeJsonArgAt(-1) as {
      pending?: Array<Record<string, unknown>>;
      paired?: Array<Record<string, unknown>>;
    };
    expect(json.pending?.[0]).toMatchObject({
      requestId: "request\u001b[2K-1",
      displayName: "Pending\u001b[1A\nNode",
    });
    expect(json.paired?.[0]).toMatchObject({
      nodeId: "paired-node",
      displayName: "Paired\u001b[2K\nNode",
      remoteIp: "10.0.0.5\rrewritten",
    });
  });

  it("runs nodes list --connected and filters to connected nodes", async () => {
    const now = Date.now();
    mockGateway({
      "node.pair.list": {
        pending: [],
        paired: [
          {
            nodeId: "n1",
            displayName: "One",
            remoteIp: "10.0.0.1",
            lastConnectedAtMs: now - 1_000,
          },
          {
            nodeId: "n2",
            displayName: "Two",
            remoteIp: "10.0.0.2",
            lastConnectedAtMs: now - 1_000,
          },
        ],
      },
      "node.list": {
        nodes: [
          { nodeId: "n1", connected: true },
          { nodeId: "n2", connected: false },
        ],
      },
    });
    await runProgram(["nodes", "list", "--connected"]);

    expectGatewayRequest("node.list", {});
    const output = getRuntimeOutput();
    expect(output).toContain("One");
    expect(output).not.toContain("Two");
  });

  it("runs nodes status --last-connected using the recorded node.list fact", async () => {
    const now = Date.now();
    const methods: string[] = [];
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      methods.push(opts.method ?? "");
      if (opts.method === "node.list") {
        return {
          ts: now,
          nodes: [
            { nodeId: "n1", displayName: "One", connected: false, lastConnectedAtMs: now - 1_000 },
            {
              nodeId: "n2",
              displayName: "Two",
              connected: false,
              lastConnectedAtMs: now - 2 * 24 * 60 * 60 * 1000,
            },
          ],
        };
      }
      return { ok: true };
    });
    await runProgram(["nodes", "status", "--last-connected", "24h"]);

    // The gateway records lastConnectedAtMs on node.list rows; re-joining
    // node.pair.list broke --last-connected for read-scoped callers.
    expect(methods).not.toContain("node.pair.list");
    const output = getRuntimeOutput();
    expect(output).toContain("One");
    expect(output).not.toContain("Two");
  });

  it.each(["status", "list"])(
    "preserves recorded connection ages in nodes %s after a stale pairing snapshot",
    async (command) => {
      const now = Date.now();
      const recent = now - 1_000;
      const old = now - 2 * 24 * 60 * 60 * 1_000;
      const nodes = [
        {
          nodeId: "reconnected",
          paired: true,
          connected: true,
          connectedAtMs: recent,
          lastConnectedAtMs: recent,
        },
        {
          nodeId: "catalog-only",
          paired: true,
          connected: false,
          lastConnectedAtMs: recent,
        },
        { nodeId: "old", paired: true, connected: false, lastConnectedAtMs: old },
        { nodeId: "unknown", paired: true, connected: false },
      ];
      programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
        const { method } = (args[0] ?? {}) as { method?: string };
        return method === "node.pair.list"
          ? { pending: [], paired: [{ nodeId: "reconnected", lastConnectedAtMs: old }] }
          : { ts: now, nodes };
      });

      await runProgram(["nodes", command, "--last-connected", "24h", "--json"]);

      const result = writeJsonArgAt(0) as {
        nodes?: Array<{ nodeId: string; lastConnectedAtMs?: number }>;
        paired?: Array<{ nodeId: string; lastConnectedAtMs?: number }>;
      };
      expect(
        (result.nodes ?? result.paired)?.map(({ nodeId, lastConnectedAtMs }) => ({
          nodeId,
          lastConnectedAtMs,
        })),
      ).toEqual([
        { nodeId: "reconnected", lastConnectedAtMs: recent },
        { nodeId: "catalog-only", lastConnectedAtMs: recent },
      ]);
    },
  );

  it.each([
    {
      label: "paired node details",
      node: connectedNode("ios-node", "iOS Node", {
        remoteIp: "192.168.0.88",
        deviceFamily: "iPad",
        modelIdentifier: "iPad16,6",
        caps: ["canvas", "camera"],
      }),
      expectedOutput: [
        "Known: 1 · Paired: 1 · Connected: 1",
        "iOS Node",
        ...statusColumns,
        "device: iPad",
        "hw: iPad16,6",
        "paired",
      ],
    },
    {
      label: "unpaired node details",
      node: connectedNode("android-node", "Peter's Tab S10 Ultra", {
        remoteIp: "192.168.0.99",
        deviceFamily: "Android",
        modelIdentifier: "samsung SM-X926B",
        caps: ["canvas", "camera"],
        paired: false,
      }),
      expectedOutput: [
        "Known: 1 · Paired: 0 · Connected: 1",
        "Peter's Tab",
        "S10 Ultra",
        ...statusColumns,
        "device: Android",
        "hw:",
        "samsung",
        "SM-X926B",
        "unpaired",
        "connected",
      ],
    },
    {
      label: "pending first node approval",
      node: connectedNode("pending-node", "Pending Node", {
        caps: [],
        commands: [],
        approvalState: "pending-approval",
        pendingRequestId: "request-approval",
        pendingDeclaredCaps: ["system"],
        pendingDeclaredCommands: ["system.run"],
      }),
      expectedOutput: [
        "Pending Node",
        "approval pending",
        "Approval pending for Pending Node",
        "openclaw nodes approve request-approval",
      ],
    },
    {
      label: "pending node reapproval",
      node: connectedNode("pending-reapproval-node", "Pending Reapproval Node", {
        caps: ["camera"],
        commands: ["camera.snap"],
        approvalState: "pending-reapproval",
        pendingRequestId: "request-reapproval",
        pendingDeclaredCaps: ["camera", "system"],
        pendingDeclaredCommands: ["camera.snap", "system.run"],
        connectedAtMs: Date.now() - 60_000,
      }),
      expectedOutput: [
        "Pending Reapproval Node",
        "reapproval pending",
        "Reapproval pending for Pending Reapproval Node",
        "openclaw nodes approve request-reapproval",
      ],
    },
  ])("runs nodes status and renders $label", async ({ label, node, expectedOutput }) => {
    programGatewayCallMock.mockResolvedValue({
      ts: Date.now(),
      nodes: [node],
    });
    await runProgram(["nodes", "status"]);

    expectGatewayRequest("node.list", {});

    const output = getRuntimeOutput();
    for (const expected of expectedOutput) {
      expect(output).toContain(expected);
    }
    if (label === "pending node reapproval") {
      expect(output).toMatch(/connected \([^)]* ago\) · reapproval pending/);
    }
    expect(
      gatewayRequests().find((request) => request.method === "node.list")?.useStoredDeviceAuth,
    ).toBe(true);
  });

  it.each([
    {
      platform: "windows",
      pathEnv: "C:\\one;D:\\two;E:\\three;F:\\four",
      expectedPath: "path: C:\\one;D:\\two;…;F:\\four",
      rejectedPath: "path: C:\\one;D:…:\\four",
    },
    {
      platform: "linux",
      pathEnv: "/one:/two:/three:/four",
      expectedPath: "path: /one:/two:…:/four",
      rejectedPath: "path: /one:/two:/three:/four",
    },
  ])("renders $platform node PATH entries with their platform delimiter", async (fixture) => {
    programGatewayCallMock.mockResolvedValue({
      ts: Date.now(),
      nodes: [
        connectedNode(`${fixture.platform}-node`, `${fixture.platform} node`, {
          platform: fixture.platform,
          pathEnv: fixture.pathEnv,
        }),
      ],
    });

    await runProgram(["nodes", "status"]);

    const output = getRuntimeOutput();
    expect(output).toContain(fixture.expectedPath);
    expect(output).not.toContain(fixture.rejectedPath);
  });

  it("runs nodes describe and calls node.describe", async () => {
    const unsafeEffectiveCommand = "camera.snap\u001b[2J\neffective-spoof";
    mockGatewayWithIosNodeListAnd("node.describe", {
      ts: Date.now(),
      nodeId: "ios-node",
      displayName: "iOS Node",
      caps: ["camera"],
      commands: [unsafeEffectiveCommand],
      approvalState: "pending-reapproval",
      pendingRequestId: "request-approval",
      pendingDeclaredCaps: ["camera", "canvas"],
      pendingDeclaredCommands: ["camera.snap", "canvas.eval\u001b[2K", "canvas.snapshot"],
      pendingDeclaredPermissions: { camera: true },
      connected: true,
    });

    await runProgram(["nodes", "describe", "--node", "ios-node"]);

    expectGatewayRequest("node.list", {});
    expectGatewayRequest("node.describe", { nodeId: "ios-node" });
    const describeRequest = gatewayRequests().find(
      (candidate) => candidate.method === "node.describe",
    );
    expect(describeRequest).toMatchObject({
      clientName: "cli",
      mode: "cli",
      useStoredDeviceAuth: true,
    });

    const out = getRuntimeOutput();
    expectOutput(
      out,
      [
        "Commands",
        "camera.snap\\neffective-spoof",
        "Approval",
        "reapproval pending",
        "Pending request",
        "request-approval",
        "Pending caps",
        "canvas",
        "Pending commands",
        "canvas.eval",
        "openclaw nodes approve request-approval",
      ],
      ["\neffective-spoof", "\u001b", "[2K", "[2J"],
    );

    await runProgram(["nodes", "describe", "--node", "ios-node", "--json"]);

    const json = writeJsonArgAt(-1) as { commands?: string[] };
    expect(json.commands).toEqual([unsafeEffectiveCommand]);
  });

  it("keeps explicit gateway options in node reapproval guidance without leaking auth", async () => {
    vi.stubEnv("OPENCLAW_PROFILE", "work");
    programGatewayCallMock.mockResolvedValue({
      ts: Date.now(),
      nodes: [
        connectedNode("pending-node", "Pending Node", {
          approvalState: "pending-reapproval",
          pendingRequestId: "request-reapproval",
        }),
      ],
    });

    await runProgram([
      "nodes",
      "status",
      "--url",
      "ws://gateway-user:url-secret@gateway.example:18789/openclaw?cluster=qa",
      "--timeout",
      "3000",
      "--token",
      "secret-token",
    ]);

    const output = getRuntimeOutput();
    expect(output).toContain(
      "openclaw --profile work nodes approve request-reapproval --timeout 3000",
    );
    expect(output).toContain("Reuse the same connection options when rerunning: --url, --token.");
    expectOutput(output, [], ["gateway-user", "url-secret", "gateway.example", "secret-token"]);
  });

  it("describes nodes through the paired-node fallback on older gateways", async () => {
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string; params?: { nodeId?: string } };
      if (opts.method === "node.list") {
        throw new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "unknown method: node.list",
        });
      }
      if (opts.method === "node.pair.list") {
        return { pending: [], paired: [{ nodeId: "legacy-node", displayName: "Legacy Node" }] };
      }
      if (opts.method === "node.describe" && opts.params?.nodeId === "legacy-node") {
        return {
          nodeId: "legacy-node",
          displayName: "Legacy Node",
          paired: true,
          connected: false,
        };
      }
      return { ok: true };
    });

    await runProgram(["nodes", "describe", "--node", "legacy-node"]);

    expectGatewayRequest("node.pair.list", {});
    expectGatewayRequest("node.describe", { nodeId: "legacy-node" });
    expect(getRuntimeOutput()).toContain("Legacy Node");
  });

  it("does not recommend approval from a stale pending request id alone", async () => {
    mockGatewayWithIosNodeListAnd("node.describe", {
      nodeId: "ios-node",
      displayName: "iOS Node",
      approvalState: "approved",
      pendingRequestId: "stale-request",
      connected: true,
    });

    await runProgram(["nodes", "describe", "--node", "ios-node", "--token", "secret-token"]);

    const output = getRuntimeOutput();
    expectOutput(
      output,
      ["stale-request"],
      [
        "openclaw nodes approve stale-request",
        "Reuse the same --token option when rerunning.",
        "secret-token",
      ],
    );
  });

  it("runs nodes approve with the pending request approval scopes", async () => {
    mockApproval({ requiredApproveScopes: ["operator.pairing", "operator.admin"] });

    await runProgram(["nodes", "approve", "r1"]);
    expectGatewayRequest("node.pair.list", {});
    expectGatewayRequest("node.pair.approve", { requestId: "r1" });
    const listRequest = gatewayRequests().find(
      (candidate) => candidate.method === "node.pair.list",
    );
    const approveRequest = gatewayRequests().find(
      (candidate) => candidate.method === "node.pair.approve",
    );
    expect(listRequest).toMatchObject({ clientName: "gateway-client", mode: "backend" });
    expect(approveRequest).toMatchObject({
      scopes: ["operator.pairing", "operator.admin"],
      clientName: "gateway-client",
      mode: "backend",
    });
  });

  it("falls back to command-derived nodes approve scopes", async () => {
    mockApproval({ commands: ["system.run"] });

    await runProgram(["nodes", "approve", "r1"]);

    const approveRequest = gatewayRequests().find(
      (candidate) => candidate.method === "node.pair.approve",
    );
    expect(approveRequest?.scopes).toEqual(["operator.pairing", "operator.admin"]);
  });

  it("rejects unsupported node approval backend methods at runtime", async () => {
    const { callNodePairApprovalGatewayCli } = await import("./nodes-cli/rpc.js");

    await expect(
      callNodePairApprovalGatewayCli(
        "node.invoke" as never,
        { json: true },
        {},
        { scopes: ["operator.admin"] },
      ),
    ).rejects.toThrow("unsupported node pair approval gateway method: node.invoke");
    expect(programGatewayCallMock).not.toHaveBeenCalled();
  });

  it("runs nodes remove and calls node.pair.remove", async () => {
    mockGateway({
      "node.list": {
        nodes: [{ nodeId: "ios-node", displayName: "iOS Node", paired: true }],
      },
      "node.pair.list": {
        pending: [],
        paired: [{ nodeId: "ios-node", displayName: "iOS Node" }],
      },
      "node.pair.remove": { nodeId: "ios-node" },
    });

    await runProgram(["nodes", "remove", "--node", "iOS Node"]);
    expectGatewayRequest("node.pair.remove", { nodeId: "ios-node" });
  });

  it("runs nodes rename and preserves the successful node.rename payload", async () => {
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const { method } = (args[0] ?? {}) as { method?: string };
      return method === "node.list"
        ? { nodes: [{ nodeId: "ios-node", displayName: "iOS Node", paired: true }] }
        : { ok: true, nodeId: "ios-node", displayName: "Renamed Node" };
    });

    await runProgram([
      "nodes",
      "rename",
      "--node",
      "iOS Node",
      "--name",
      " Renamed Node ",
      "--json",
    ]);

    expectGatewayRequest("node.rename", { nodeId: "ios-node", displayName: "Renamed Node" });
    expect(writeJsonArgAt(0)).toEqual({
      ok: true,
      nodeId: "ios-node",
      displayName: "Renamed Node",
    });
  });

  it("reports the inventory timeout instead of invoking a stale paired node", async () => {
    const timeout = new GatewayProtocolRequestTimeoutError({
      method: "node.list",
      timeoutMs: 80,
      requestSent: true,
    });
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const { method } = (args[0] ?? {}) as { method?: string };
      if (method === "node.list") {
        throw timeout;
      }
      if (method === "node.pair.list") {
        return { pending: [], paired: [{ nodeId: "stale-node", displayName: "Stale Node" }] };
      }
      throw new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "node not connected",
      });
    });

    await expect(
      runProgram(["nodes", "invoke", "--node", "Stale Node", "--command", "canvas.hide"]),
    ).rejects.toThrow("exit");

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(timeout.message));
    expect(gatewayRequests().map(({ method }) => method)).toEqual(["node.list"]);
    expect(runtime.writeJson).not.toHaveBeenCalled();
  });
});
