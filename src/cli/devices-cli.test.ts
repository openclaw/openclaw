import { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { registerDevicesCli } from "./devices-cli.js";
import { ExpectedCliError } from "./failure-output.js";

const mocks = vi.hoisted(() => ({
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn(), writeJson: vi.fn() },
  callGateway: vi.fn(),
  formatGatewayTransportErrorJson: vi.fn(),
  listDevicePairing: vi.fn(),
  approveDevicePairing: vi.fn(),
  summarizeDeviceTokens: vi.fn(),
}));
const { runtime, callGateway, listDevicePairing, approveDevicePairing } = mocks;
vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
  formatGatewayTransportErrorJson: mocks.formatGatewayTransportErrorJson,
  buildGatewayConnectionDetails: () => ({
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
    message: "",
  }),
}));
// mock-isolation: Pairing policy is stubbed below; runtime config loading is not part of this unit contract.
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("./progress.js", () => ({
  withProgress: async (_opts: unknown, fn: () => Promise<unknown>) => await fn(),
}));
vi.mock("../infra/device-pairing.js", () => ({ listDevicePairing: mocks.listDevicePairing }));
vi.mock("../infra/device-pairing-approval.js", () => ({
  approveDevicePairing: mocks.approveDevicePairing,
}));
vi.mock("../infra/device-pairing-tokens.js", () => ({
  summarizeDeviceTokens: mocks.summarizeDeviceTokens,
}));
vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (target: { log: (...args: unknown[]) => void }, value: unknown, space = 2) =>
    target.log(JSON.stringify(value, null, space > 0 ? space : undefined)),
}));

const roots = createSuiteTempRootTracker({ prefix: "openclaw-devices-cli-" });
beforeAll(async () => {
  await roots.setup();
});
afterAll(async () => {
  await roots.cleanup();
});
beforeEach(async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", await roots.make());
  vi.clearAllMocks();
  runtime.exit.mockImplementation(() => {});
  mocks.formatGatewayTransportErrorJson.mockReturnValue(null);
  listDevicePairing.mockResolvedValue({ pending: [], paired: [] });
  approveDevicePairing.mockResolvedValue(undefined);
  mocks.summarizeDeviceTokens.mockReturnValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

async function run(...argv: string[]) {
  const program = new Command().exitOverride();
  registerDevicesCli(program);
  await program.parseAsync(["devices", ...argv], { from: "user" });
}
async function refusal(...argv: string[]): Promise<string> {
  const failure: unknown = await run(...argv).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) {
    throw new Error("Expected a devices refusal");
  }
  expect(failure).toBeInstanceOf(ExpectedCliError);
  expect(failure).toMatchObject({
    humanOutput: failure.message,
    machineOutput: failure.message,
  });
  expect(runtime.error).not.toHaveBeenCalled();
  expect(runtime.writeJson).not.toHaveBeenCalled();
  expect(runtime.exit).not.toHaveBeenCalled();
  return failure.message;
}
const output = () => runtime.log.mock.calls.map(([text]) => text).join("\n");
const errors = () => stripAnsi(runtime.error.mock.calls.map(([text]) => text).join("\n"));
function expectCall(index: number, fields: Record<string, unknown>) {
  expect(callGateway.mock.calls[index]?.[0]).toEqual(expect.objectContaining(fields));
}
function pending(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    deviceId: "device-1",
    displayName: "Device One",
    role: "operator",
    scopes: ["operator.admin"],
    ts: 1,
    ...overrides,
  };
}
function paired(overrides: Record<string, unknown> = {}) {
  return {
    deviceId: "device-1",
    displayName: "Device One",
    roles: ["operator"],
    scopes: ["operator.read"],
    ...overrides,
  };
}
function list(requests: unknown[] = [], devices: unknown[] = []) {
  return callGateway.mockResolvedValueOnce({ pending: requests, paired: devices });
}
function deny(message = "gateway closed (1008): pairing required") {
  callGateway.mockRejectedValueOnce(new Error(message));
}
function nodeDevice(operatorLabel = "Kitchen Mac") {
  return paired({
    deviceId: "android-node",
    displayName: "Colin's S25",
    operatorLabel,
    remoteIp: "192.168.0.202",
    role: "node",
    roles: [],
    nodeSurface: { displayName: "Colin's S25", createdAtMs: 1, approvedAtMs: 1 },
    pendingNodeSurface: {
      requestId: "node-req-1",
      revision: "revision-1",
      displayName: "Colin's S25",
      remoteIp: "192.168.0.202",
      ts: 2,
    },
  });
}
function replacementPairing(
  params: {
    original?: Record<string, unknown> | null;
    replacement?: Record<string, unknown>;
    paired?: Record<string, unknown>[];
    vanished?: boolean;
  } = {},
) {
  const request = (requestId: string, overrides: Record<string, unknown> = {}) => ({
    requestId,
    deviceId: "device-1",
    publicKey: "pk",
    ...(Object.hasOwn(overrides, "roles") ? {} : { role: "operator" }),
    scopes: requestId === "req-old" ? ["operator.read"] : ["operator.read", "operator.pairing"],
    clientId: "openclaw-macos",
    clientMode: "cli",
    isRepair: true,
    ts: requestId === "req-old" ? 1 : 2,
    ...overrides,
  });
  const replacement = request("req-new", params.replacement);
  const devices = params.paired ?? [];
  deny("scope upgrade pending approval (requestId: req-new)");
  deny("scope upgrade pending approval (requestId: req-new)");
  listDevicePairing
    .mockResolvedValueOnce({
      pending:
        params.original === null
          ? [replacement]
          : [request("req-old", params.original), replacement],
      paired: devices,
    })
    .mockResolvedValueOnce({ pending: params.vanished ? [] : [replacement], paired: devices });
}
function approveReplacement() {
  approveDevicePairing.mockResolvedValueOnce({
    requestId: "req-new",
    device: { deviceId: "device-1", publicKey: "pk", approvedAtMs: 1, createdAtMs: 1 },
  });
}
const fallbackNotice = "Direct scope access failed; using local fallback.";

describe("approval", () => {
  it.each([
    { name: "explicit admin", request: pending(), device: paired(), scopes: ["operator.admin"] },
    {
      name: "inherited operator token",
      request: pending({ scopes: [] }),
      device: paired({ tokens: [{ role: "operator", scopes: ["operator.read"] }] }),
      scopes: ["operator.pairing", "operator.read"],
    },
  ])("selects scopes for $name", async ({ request, device, scopes }) => {
    list([request], [device]).mockResolvedValueOnce({ device: { deviceId: "device-1" } });
    await run("approve", "req-1");
    expect(callGateway).toHaveBeenCalledTimes(2);
    expectCall(0, { method: "device.pair.list", scopes: ["operator.pairing"] });
    expectCall(1, { method: "device.pair.approve", params: { requestId: "req-1" }, scopes });
  });

  it("previews the latest upgrade with safe output and a profile-aware approval command", async () => {
    vi.stubEnv("OPENCLAW_PROFILE", "work");
    list(
      [
        pending({ requestId: "req-old", ts: 1 }),
        pending({ requestId: "req-latest", ts: 2, remoteIp: "10.0.0.9\rspoof" }),
      ],
      [paired()],
    );
    await run(
      "approve",
      "req-old",
      "--latest",
      "--url",
      "ws://gateway.example:18789/openclaw?cluster=qa lab",
      "--timeout",
      "3000",
      "--token",
      "secret-token",
      "--password",
      "secret-password",
    );
    expect(callGateway).toHaveBeenCalledOnce();
    expect(output()).toContain("req-latest");
    expect(output()).toContain("Device One");
    expect(output()).toContain("Approved: roles: operator; scopes: operator.read");
    expect(output()).toContain("Requested scopes exceed the current approval");
    expect(output()).toContain("IP:     10.0.0.9spoof");
    expect(output()).not.toContain("\r");
    expect(errors()).toContain(
      "openclaw --profile work devices approve req-latest --url 'ws://gateway.example:18789/openclaw?cluster=qa lab' --timeout 3000",
    );
    expect(errors()).toContain("Reuse the same --token/--password options when rerunning.");
    expect(errors()).not.toMatch(/secret-token|secret-password/);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("previews new pairing by device id when no request id or display name is supplied", async () => {
    list([{ requestId: "req-blank", deviceId: "device-9", displayName: "   ", ts: 1 }]);
    await run("approve");
    expect(callGateway).toHaveBeenCalledOnce();
    expect(output()).toContain("device-9");
    expect(output()).toContain("First-time device pairing request");
    expect(errors()).toContain("openclaw devices approve req-blank");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("returns a JSON preview with container precedence", async () => {
    vi.stubEnv("OPENCLAW_PROFILE", "work");
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", "demo");
    const selected = { requestId: "req-json", deviceId: "device-json", ts: 1 };
    list([selected]);
    await run("approve", "--latest", "--json", "--url", "ws://gateway.example:18789");
    expect(callGateway).toHaveBeenCalledOnce();
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.writeJson).toHaveBeenCalledWith({
      selected,
      approvalState: { kind: "new-pairing", requested: { roles: [], scopes: [] }, approved: null },
      approveCommand:
        "openclaw --container demo devices approve req-json --url ws://gateway.example:18789 --json",
      requiresAuthFlags: { token: false, password: false },
    });
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("refuses implicit approval without pending requests", async () => {
    callGateway.mockResolvedValueOnce({ pending: [] });
    await run("approve");
    expect(callGateway).toHaveBeenCalledOnce();
    expect(runtime.error).toHaveBeenCalledWith("No pending device pairing requests to approve");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("routes an empty pending list through the root JSON failure handler", async () => {
    list();
    expect(await refusal("approve", "--json")).toBe(
      "No pending device pairing requests to approve",
    );
    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("suggests node reapproval for a device IP without exposing connection credentials", async () => {
    list([], [nodeDevice()])
      .mockRejectedValueOnce(new Error("device pairing approval denied"))
      .mockRejectedValueOnce({ message: "unknown requestId", gatewayCode: "INVALID_REQUEST" });
    const message = await refusal(
      "approve",
      "192.168.0.202",
      "--json",
      "--url",
      "ws://gateway-user:url-secret@gateway.example:18789/openclaw?cluster=qa",
      "--token",
      "secret-token",
    );
    expect(callGateway).toHaveBeenCalledTimes(3);
    expect(message).toContain("No pending device request matches");
    expect(message).toContain("Node reapproval pending for Kitchen Mac. Run");
    expect(message).toContain("openclaw nodes approve node-req-1");
    expect(message).toContain("Reuse the same connection options when rerunning: --url, --token.");
    expect(message).not.toMatch(/gateway-user|url-secret|gateway.example|secret-token/);
  });

  it("does not treat cosmetic device names as node approval identifiers", async () => {
    list(
      [],
      [{ ...nodeDevice("Shared Phone"), displayName: "Shared Phone" }],
    ).mockRejectedValueOnce({ message: "unknown requestId", gatewayCode: "INVALID_REQUEST" });
    const message = await refusal("approve", "Shared Phone", "--json");
    expect(callGateway).toHaveBeenCalledTimes(2);
    expect(message).toContain("No pending device request matches Shared Phone");
    expect(message).not.toContain("openclaw nodes approve");
  });

  it("preserves scope-upgrade recovery guidance in a JSON refusal", async () => {
    list().mockRejectedValueOnce(
      new Error("scope upgrade pending approval (requestId: req-remote)"),
    );
    expect(
      await refusal("approve", "req-remote", "--json", "--url", "wss://gateway.example/ws"),
    ).toBe(
      "This device can't approve its own scope upgrade. Approve it from the Control UI or another authorized device.",
    );
    expect(callGateway).toHaveBeenCalledTimes(2);
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });

  it("sanitizes device-controlled node guidance before throwing", async () => {
    list([], [nodeDevice("Bad\u001b[2J\nName\r")]).mockRejectedValueOnce({
      message: "unknown requestId",
      gatewayCode: "INVALID_REQUEST",
    });
    const message = await refusal("approve", "192.168.0.202", "--json");
    expect(message).toContain("Node reapproval pending for BadName. Run");
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("\r");
  });
});

describe("mutations", () => {
  it("removes a paired device", async () => {
    callGateway.mockResolvedValueOnce({ deviceId: "device-1" });
    await run("remove", "device-1");
    expect(callGateway).toHaveBeenCalledOnce();
    expectCall(0, { method: "device.pair.remove", params: { deviceId: "device-1" } });
  });
  it("normalizes rejection ids and forwards integer timeouts", async () => {
    callGateway.mockResolvedValueOnce({ requestId: "req-1", deviceId: "device-1" });
    await run("reject", "  req-1  ", "--timeout", "15000");
    expect(callGateway).toHaveBeenCalledOnce();
    expectCall(0, {
      method: "device.pair.reject",
      params: { requestId: "req-1" },
      timeoutMs: 15000,
    });
  });
  it("rejects malformed timeout before connecting", async () => {
    await expect(run("reject", "req-1", "--timeout", "10ms")).rejects.toThrow(
      'Invalid --timeout. Use a positive millisecond value, e.g. --timeout 30000. Received: "10ms".',
    );
    expect(callGateway).not.toHaveBeenCalled();
  });
  it("explains blank rejection ids", async () => {
    await run("reject", "   ");
    expect(callGateway).not.toHaveBeenCalled();
    expect(errors()).toContain("requestId is required.");
    expect(errors()).toContain("openclaw devices list");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
  it("requires confirmation before clearing", async () => {
    await run("clear");
    expect(callGateway).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith("Refusing to clear pairing table without --yes");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
  it("clears every paired device and pending request", async () => {
    list([{ requestId: "req-1" }], [{ deviceId: "device-1" }, { deviceId: "device-2" }])
      .mockResolvedValueOnce({ deviceId: "device-1" })
      .mockResolvedValueOnce({ deviceId: "device-2" })
      .mockResolvedValueOnce({ requestId: "req-1", deviceId: "device-1" });
    await run("clear", "--yes", "--pending");
    expect(callGateway).toHaveBeenCalledTimes(4);
    expectCall(0, { method: "device.pair.list" });
    expectCall(1, { method: "device.pair.remove", params: { deviceId: "device-1" } });
    expectCall(2, { method: "device.pair.remove", params: { deviceId: "device-2" } });
    expectCall(3, { method: "device.pair.reject", params: { requestId: "req-1" } });
  });
  it.each([
    { name: "omitted", flags: [], scopes: undefined },
    { name: "empty", flags: ["--no-scopes"], scopes: [] },
  ])("preserves $name node rotation scope intent", async ({ flags, scopes }) => {
    callGateway.mockResolvedValueOnce({ ok: true });
    await run("rotate", "--device", "device-1", "--role", "node", ...flags);
    expect(callGateway).toHaveBeenCalledOnce();
    expectCall(0, {
      method: "device.token.rotate",
      params: { deviceId: "device-1", role: "node", scopes },
      scopes: ["operator.admin"],
    });
    expect(runtime.writeJson).toHaveBeenCalledWith({ ok: true });
  });
  it.each(["rotate", "revoke"])(
    "routes blank %s targets as JSON without the explicit flag",
    async (operation) => {
      const message = await refusal(operation, "--device", " ", "--role", "node");
      expect(callGateway).not.toHaveBeenCalled();
      expect(message).toContain("--device and --role are required.");
      expect(message).toContain("devices list");
    },
  );
  it.each([
    { args: ["clear"], message: "Refusing to clear pairing table without --yes" },
    { args: ["remove", ""], message: "deviceId is required." },
    { args: ["reject", " "], message: "requestId is required." },
    {
      args: ["rename", "--device", "", "--name", "Proof"],
      message: "--device and --name are required.",
    },
    {
      args: ["rename", "--device", "device-1", "--name", " "],
      message: "--device and --name are required.",
    },
    {
      args: ["rotate", "--device", "device-1", "--role", ""],
      message: "--device and --role are required.",
    },
    {
      args: ["revoke", "--device", "", "--role", "node"],
      message: "--device and --role are required.",
    },
  ])("routes $args local JSON refusals before RPC", async ({ args, message }) => {
    expect(await refusal(...args, "--json")).toContain(message);
    expect(callGateway).not.toHaveBeenCalled();
  });
  it("renames a device", async () => {
    callGateway.mockResolvedValueOnce({ deviceId: "device-1", label: "Kitchen Mac" });
    await run("rename", "--device", "device-1", "--name", "Kitchen Mac");
    expectCall(0, {
      method: "device.pair.rename",
      params: { deviceId: "device-1", label: "Kitchen Mac" },
    });
    expect(stripAnsi(output())).toContain("Kitchen Mac");
  });
  it("mints a join URL with admin scope and prints the pasteable command", async () => {
    const joinUrl = `https://gateway.example/j/${"a".repeat(22)}`;
    callGateway.mockResolvedValueOnce({
      joinUrl,
      setupCode: "opaque",
      command: `npx -y openclaw@2026.9.9 connect ${joinUrl} --service --session-host`,
      serviceCommand: `npx -y openclaw@2026.9.9 connect ${joinUrl} --service`,
      installedCommand: `openclaw connect ${joinUrl} --service --session-host`,
    });
    await run("join-code");
    expectCall(0, {
      method: "device.pair.setupCode",
      params: { bootstrapProfile: "node", includeQr: false, joinUrl: true },
      scopes: ["operator.admin"],
    });
    expect(output()).toContain(joinUrl);
    expect(output()).toContain(
      `npx -y openclaw@2026.9.9 connect ${joinUrl} --service --session-host`,
    );
    expect(output()).toContain("Installs a background node service that can run agent sessions.");
    expect(output()).toContain(
      `Command-only node: npx -y openclaw@2026.9.9 connect ${joinUrl} --service`,
    );
    expect(output()).toContain(
      `Already have OpenClaw installed? Run: openclaw connect ${joinUrl} --service --session-host`,
    );
    expect(output()).not.toContain("opaque");
  });
  it.each([undefined, "The machine needs a matching Gateway build."])(
    "returns the Gateway commands in JSON without printing text (%s)",
    async (versionNote) => {
      const joinUrl = `https://gateway.example/j/${"b".repeat(22)}`;
      const commands = {
        command: `npx -y openclaw@2026.9.9 connect ${joinUrl} --service --session-host`,
        serviceCommand: `npx -y openclaw@2026.9.9 connect ${joinUrl} --service`,
        installedCommand: `openclaw connect ${joinUrl} --service --session-host`,
        ...(versionNote ? { versionNote } : {}),
      };
      callGateway.mockResolvedValueOnce({ joinUrl, ...commands });
      await run("join-code", "--json");
      expect(runtime.writeJson).toHaveBeenCalledWith({ joinUrl, ...commands });
      expect(runtime.log).not.toHaveBeenCalled();
    },
  );
});

describe("local fallback", () => {
  it("approves locally after a loopback pairing-required denial", async () => {
    deny();
    deny();
    listDevicePairing.mockResolvedValueOnce({
      pending: [{ requestId: "req-1", deviceId: "device-1", publicKey: "pk", ts: 1 }],
      paired: [],
    });
    approveDevicePairing.mockResolvedValueOnce({
      requestId: "req-1",
      device: { deviceId: "device-1", publicKey: "pk", approvedAtMs: 1, createdAtMs: 1 },
    });
    await run("approve", "req-1");
    expect(approveDevicePairing).toHaveBeenCalledWith(
      "req-1",
      {
        callerScopes: ["operator.admin"],
        isApprovalCurrent: expect.any(Function),
      },
      process.env.OPENCLAW_STATE_DIR,
    );
    expect(output()).toContain(fallbackNotice);
    expect(output()).toContain("Approved");
  });
  it("approves a compatible replacement using inherited operator scopes", async () => {
    replacementPairing({
      original: { scopes: [] },
      paired: [
        {
          deviceId: "device-1",
          publicKey: "pk",
          roles: ["operator"],
          scopes: ["operator.read"],
          tokens: [{ role: "operator", scopes: ["operator.read"] }],
        },
      ],
    });
    approveReplacement();
    await run("approve", "req-old");
    expect(listDevicePairing).toHaveBeenCalledTimes(2);
    expect(approveDevicePairing).toHaveBeenCalledWith(
      "req-new",
      {
        callerScopes: ["operator.admin"],
        isApprovalCurrent: expect.any(Function),
      },
      process.env.OPENCLAW_STATE_DIR,
    );
    expect(output()).toContain(fallbackNotice);
    expect(output()).toContain(
      "Pending request req-old was replaced by same-device repair req-new; approving latest compatible request.",
    );
    expect(output()).toContain("(req-new)");
  });
  it("emits resolved replacement metadata in JSON mode", async () => {
    replacementPairing();
    approveReplacement();
    await run("approve", "req-old", "--json");
    expect(runtime.writeJson).toHaveBeenCalledWith({
      requestId: "req-new",
      resolved: {
        kind: "same-device-replacement",
        requestedRequestId: "req-old",
        approvedRequestId: "req-new",
      },
      device: {
        deviceId: "device-1",
        publicKey: "pk",
        approvedAtMs: 1,
        createdAtMs: 1,
        tokens: undefined,
      },
    });
    expect(runtime.log).not.toHaveBeenCalled();
  });
  it.each([
    { name: "missing original", original: null },
    {
      name: "lost scope",
      original: { scopes: ["operator.read", "operator.write"] },
      replacement: { scopes: ["operator.pairing"] },
    },
    { name: "broader scopes", replacement: { scopes: ["operator.read", "operator.write"] } },
    { name: "different device", replacement: { deviceId: "device-2" } },
    {
      name: "different key",
      original: { publicKey: "pk-old" },
      replacement: { publicKey: "pk-new" },
    },
    { name: "changed roles", replacement: { roles: ["operator", "different-role"] } },
    {
      name: "conflicting metadata",
      replacement: { clientId: "openclaw-ios", clientMode: "agent" },
    },
  ])("refuses replacement with $name", async ({ original, replacement }) => {
    replacementPairing({ original, replacement });
    await expect(run("approve", "req-old")).rejects.toThrow(
      "local fallback pairing state does not contain the gateway request",
    );
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });
  it("explains recovery when both requests have disappeared", async () => {
    replacementPairing({ vanished: true });
    await run("approve", "req-old");
    expect(errors()).toContain("No pending device request matches req-old");
    expect(errors()).toContain("openclaw devices list");
    expect(errors()).not.toContain("unknown requestId");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });
  it("directs a remote scope upgrade to another authorized device", async () => {
    deny("scope upgrade pending approval (requestId: req-remote)");
    deny("scope upgrade pending approval (requestId: req-remote)");
    await run("approve", "req-remote", "--url", "wss://gateway.example.com/ws");
    expect(errors()).toContain("can't approve its own scope upgrade");
    expect(errors()).toContain("Control UI");
    expect(errors()).toContain("another authorized device");
    expect(errors()).not.toMatch(/--token|--password/);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
  it("points at the current request when a gateway request is stale", async () => {
    vi.stubEnv("OPENCLAW_PROFILE", "work");
    deny("scope upgrade pending approval (requestId: req-profile)");
    listDevicePairing.mockResolvedValueOnce({
      pending: [{ requestId: "req-default", deviceId: "device-1", publicKey: "pk", ts: 1 }],
      paired: [],
    });
    const failure = await run("list").then(
      () => {
        throw new Error("expected devices list to fail");
      },
      (error: unknown) => String(error),
    );
    expect(failure).toContain("superseded by a newer pending request");
    expect(failure).toContain("openclaw --profile work devices approve req-default");
    expect(failure).not.toMatch(/OPENCLAW_PROFILE|--token/);
    expect(output()).not.toContain(fallbackNotice);
  });
  it("preserves the mismatch error when the gateway request is absent locally", async () => {
    deny("device pairing required (requestId: req-profile)");
    deny("device pairing required (requestId: req-profile)");
    await expect(run("approve", "req-profile")).rejects.toThrow(
      "local fallback pairing state does not contain the gateway request",
    );
    expect(output()).not.toContain(fallbackNotice);
  });
  it("never falls back locally for an explicit URL", async () => {
    deny();
    await expect(run("list", "--json", "--url", "ws://127.0.0.1:18789")).rejects.toThrow(
      "pairing required",
    );
    expect(listDevicePairing).not.toHaveBeenCalled();
  });
});

describe("list output", () => {
  it("prints profile-aware node reapproval hints with a blank operator label", async () => {
    vi.stubEnv("OPENCLAW_PROFILE", "work");
    list([], [nodeDevice("   ")]);
    await run(
      "list",
      "--url",
      "ws://gateway-user:url-secret@gateway.example:18789/openclaw?cluster=qa",
      "--token",
      "secret-token",
    );
    expect(callGateway).toHaveBeenCalledOnce();
    expect(output()).toContain("Node reapproval pending for Colin's S25. Run");
    expect(output()).toContain("openclaw --profile work nodes approve node-req-1");
    expect(output()).toContain("Reuse the same connection options when rerunning: --url, --token.");
    expect(output()).not.toMatch(/gateway-user|url-secret|gateway.example|secret-token/);
  });
  it("does not show prior approval for key-mismatched requests", async () => {
    list([pending({ publicKey: "new-key" })], [paired({ publicKey: "old-key" })]);
    await run("list");
    expect(output()).toContain("new pairing");
    expect(output()).not.toContain("scope upgrade");
    expect(output()).not.toContain("roles: operator; scopes: operator.read");
  });
  it("sanitizes device-controlled terminal output", async () => {
    list(
      [pending({ displayName: "Bad\u001b[2J\nName", remoteIp: "10.0.0.9\rspoof" })],
      [
        paired({
          displayName: "Pair\u001b]8;;https://evil.example\u001b\\ed",
          remoteIp: "10.0.0.1\u007f",
        }),
      ],
    );
    await run("list");
    const text = stripAnsi(output());
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\r");
    expect(text).toContain("BadName");
    expect(text).toContain("spoof");
    expect(text).toContain("Paired");
  });
  it("emits transport failures as JSON", async () => {
    const error = new Error("gateway closed (1006)");
    const payload = {
      ok: false,
      error: { type: "gateway_transport_error", kind: "closed", message: error.message },
      gateway: { url: "ws://127.0.0.1:18789", urlSource: "local loopback" },
    };
    callGateway.mockRejectedValueOnce(error);
    mocks.formatGatewayTransportErrorJson.mockReturnValueOnce(payload);
    await run("list", "--json");
    expect(mocks.formatGatewayTransportErrorJson).toHaveBeenCalledWith(error);
    expect(runtime.writeJson).toHaveBeenCalledWith(payload);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
  it("shows full ids alongside the preferred paired-device names", async () => {
    const firstId = "a".repeat(64);
    const secondId = "b".repeat(64);
    list(
      [],
      [
        paired({
          deviceId: firstId,
          operatorLabel: "Kitchen Mac",
          displayName: "MacBook Pro",
          clientId: "openclaw-macos",
        }),
        paired({ deviceId: secondId, displayName: "Kitchen Mac", clientId: "openclaw-ios" }),
        paired({ deviceId: "dev-client", displayName: undefined, clientId: "openclaw-control-ui" }),
        paired({ deviceId: "dev-id-only", displayName: undefined }),
      ],
    );
    await run("list");
    const text = stripAnsi(output());
    expect(text).toContain("Device ID");
    expect(text).toContain("Full device IDs");
    expect(text.split("\n")).toContain(`  ${firstId}  Kitchen Mac`);
    expect(text.split("\n")).toContain(`  ${secondId}  Kitchen Mac`);
    expect(text).toContain("openclaw-control-ui");
    expect(text).toContain("dev-id-only");
    expect(text).not.toMatch(/MacBook Pro|openclaw-macos|openclaw-ios/);
  });
});
