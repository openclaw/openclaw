import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { decodeClaudeCliNodeRunParams } from "../node-host/invoke-agent-cli-claude-params.js";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  invoke: vi.fn(),
  getRuntimeConfig: vi.fn(() => ({})),
  isNodeCommandAllowed: vi.fn(),
  resolveNodeCommandAllowlist: vi.fn(() => new Set<string>()),
}));

vi.mock("../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRuntimeGatewayRequestScope: () => ({
    context: {
      getRuntimeConfig: mocks.getRuntimeConfig,
      nodeRegistry: { get: mocks.get, invoke: mocks.invoke },
    },
  }),
}));

vi.mock("./node-command-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./node-command-policy.js")>()),
  isNodeCommandAllowed: mocks.isNodeCommandAllowed,
  resolveNodeCommandAllowlist: mocks.resolveNodeCommandAllowlist,
}));

import { invokeNodeClaudeCliRun } from "./node-agent-cli-runtime.js";
import { NodeRegistry } from "./node-registry.js";
import { makeClient } from "./node-registry.test-helpers.js";

function invoke(overrides: Partial<Parameters<typeof invokeNodeClaudeCliRun>[0]> = {}) {
  return invokeNodeClaudeCliRun({
    nodeId: "node-1",
    argv: ["-p"],
    stdin: "hello",
    timeoutMs: 10_000,
    idleTimeoutMs: 1_000,
    onProgress: () => {},
    ...overrides,
  });
}

describe("invokeNodeClaudeCliRun", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.invoke.mockReset();
    mocks.getRuntimeConfig.mockClear();
    mocks.resolveNodeCommandAllowlist.mockClear();
    mocks.isNodeCommandAllowed.mockReset();
    mocks.get.mockReturnValue({
      connId: "conn-1",
      nodeId: "node-1",
      pairingGeneration: "generation-1",
      commands: ["agent.cli.claude.run.v1"],
      caps: [],
    });
  });

  it("fails closed when Gateway node command policy denies the agent run", async () => {
    mocks.isNodeCommandAllowed.mockReturnValue({ ok: false, reason: "denyCommands" });

    await expect(invoke()).resolves.toEqual({
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        message:
          "paired-node Claude CLI agent runs are blocked by node command policy (denyCommands)",
      },
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("dispatches only after the command policy allows the advertised command", async () => {
    mocks.isNodeCommandAllowed.mockReturnValue({ ok: true });
    mocks.invoke.mockResolvedValue({ ok: true });

    const credentials = {
      env: { CLAUDE_CODE_OAUTH_TOKEN: "selected-node-token" },
      clearEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    };
    await expect(invoke(credentials)).resolves.toEqual({ ok: true });
    expect(mocks.resolveNodeCommandAllowlist).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls).toMatchObject([
      [
        {
          expectedConnId: "conn-1",
          expectedPairingGeneration: "generation-1",
          params: credentials,
        },
      ],
    ]);
  });

  it.each([false, true])(
    "negotiates native-only auth with node support (%s)",
    async (supported) => {
      mocks.isNodeCommandAllowed.mockReturnValue({ ok: true });
      mocks.get.mockReturnValue({
        ...mocks.get(),
        caps: supported ? ["claude-cli-native-auth-v1"] : [],
      });
      mocks.invoke.mockImplementation(async ({ params }) => {
        if (!supported && Object.hasOwn(params, "nativeAuthOnly")) {
          throw new Error("INVALID_REQUEST: unknown param nativeAuthOnly");
        }
        const decoded = await decodeClaudeCliNodeRunParams(JSON.stringify(params));
        expect(decoded.nativeAuthOnly).toBe(supported ? true : undefined);
        return { ok: true };
      });

      await expect(invoke({ nativeAuthOnly: true })).resolves.toEqual({ ok: true });
      expect(mocks.invoke).toHaveBeenCalledOnce();
    },
  );

  it("withholds private history revoked while node pairing is pending", async () => {
    const pairingEntered = createDeferred();
    const pairing = createDeferred<{ identity: string; generation: string }>();
    const resolveCurrentPairingState = vi.fn(() => {
      pairingEntered.resolve();
      return pairing.promise;
    });
    const registry = new NodeRegistry({ resolveCurrentPairingState });
    const pairingIdentity = { identity: "identity-a", generation: "generation-1" };
    const transport = { send: vi.fn(() => false), sendRaw: vi.fn(() => false) };
    registry.registerTransport(
      makeClient("conn-1", "node-1", [], { commands: ["agent.cli.claude.run.v1"] }),
      { pairingIdentity: "identity-a", pairingGeneration: "generation-1" },
      transport,
    );
    mocks.get.mockImplementation((nodeId: string) => registry.get(nodeId));
    mocks.invoke.mockImplementation((params: Parameters<NodeRegistry["invoke"]>[0]) =>
      registry.invoke(params),
    );
    mocks.isNodeCommandAllowed.mockReturnValue({ ok: true });
    let readable = true;
    const revoked = new Error("session history access revoked");
    const assertReadable = vi.fn(async () => {
      if (!readable) {
        throw revoked;
      }
    });
    const invocation = invoke({
      stdin: "private conversation history",
      assertReadable,
    });
    try {
      await Promise.race([pairingEntered.promise, invocation]);
      expect(resolveCurrentPairingState).toHaveBeenCalledOnce();
      expect(assertReadable).not.toHaveBeenCalled();
      expect(transport.send).not.toHaveBeenCalled();
      readable = false;
      pairing.resolve(pairingIdentity);
      await expect(invocation).rejects.toBe(revoked);
      expect(assertReadable).toHaveBeenCalledOnce();
      expect(transport.send).not.toHaveBeenCalled();
      expect(transport.sendRaw).not.toHaveBeenCalled();
    } finally {
      pairing.resolve(pairingIdentity);
      registry.unregister("conn-1");
    }
  });
});
