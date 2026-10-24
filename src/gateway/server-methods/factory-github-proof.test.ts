import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { issueFactoryGitHubProof } from "../factory-github-proof.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { gatewayConnect } from "../server/client-fixtures.test-support.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import { expectRpcError } from "./rpc-response.test-support.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./types.js";

vi.mock("../../agents/github-host-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/github-host-runtime.js")>()),
  resolveGitHubHost: () => "example.ghe.com",
}));

const releases: Array<() => void> = [];
afterEach(() => {
  releases.splice(0).forEach((release) => release());
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
beforeEach(() => vi.stubEnv("FACTORY_AUTH_MODE", "github"));

const claim = {
  purpose: "session-item-read" as const,
  binding: {
    kind: "session" as const,
    agentId: "main",
    sessionKey: "agent:main:room",
    sessionId: "session-1",
    lifecycleRevision: "revision-1",
    requestDigest: "digest-1",
  },
};

function issue(assertCurrent = () => {}) {
  const proof = issueFactoryGitHubProof({
    actorId: 101,
    profileId: "person-1",
    claim,
    assertCurrent,
  });
  releases.push(proof.release);
  return proof;
}

function expectForbidden(respond: Awaited<ReturnType<typeof rpc>>) {
  expectRpcError(respond, { code: "FORBIDDEN" });
}

const broker: GatewayClient = {
  connId: "broker-connection",
  connect: gatewayConnect(["operator.admin"], { id: "cli", mode: "cli" }),
  internal: {
    isLocalClient: true,
    authenticatedOperator: true,
    operatorRoleActor: { kind: "system" },
  },
};

async function rpc(
  proof: string,
  clientOverrides: Partial<GatewayClient> = {},
  requestOverrides: Partial<
    Pick<GatewayRequestHandlerOptions, "hasCurrentClientAuthority" | "signal">
  > = {},
) {
  const respond = vi.fn();
  const method = "factory.githubPublication.redeem";
  await coreGatewayHandlers[method]?.({
    client: { ...broker, ...clientOverrides },
    context: createDirectChatContext({ isConnectionActive: () => true }),
    req: { type: "req", id: "proof-request", method },
    isWebchatConnect: () => false,
    params: { proof },
    respond,
    hasCurrentClientAuthority: () => true,
    ...requestOverrides,
  });
  return respond;
}

it("redeems the exact session read once through the registered direct private method", async () => {
  const issued = issue();
  expect(await rpc(issued.proof)).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      ...claim,
      actorId: 101,
      actorPrincipal: "github:example.ghe.com:101",
      profileId: "person-1",
    }),
  );
  expectForbidden(await rpc(issued.proof));
});

it("rejects public proxy connections and revoked original authority", async () => {
  let current = true;
  const issued = issue(() => {
    if (!current) {
      throw new Error("Original caller revoked");
    }
  });
  expectForbidden(
    await rpc(issued.proof, {
      internal: { authenticatedOperator: true, operatorRoleActor: { kind: "system" } },
    }),
  );
  current = false;
  expectForbidden(await rpc(issued.proof));
  current = true;
  expectForbidden(await rpc(issued.proof));
});

it.each([
  ["non-admin", { connect: { ...broker.connect, scopes: ["operator.read"] } }, {}],
  [
    "non-system",
    {
      internal: {
        ...broker.internal,
        operatorRoleActor: { kind: "operator", profileId: "person-1" },
      },
    },
    {},
  ],
  ["retired", {}, { hasCurrentClientAuthority: () => false }],
  ["aborted", {}, { signal: AbortSignal.abort() }],
] satisfies Array<[string, Partial<GatewayClient>, Parameters<typeof rpc>[2]]>)(
  "refuses broker redemption with %s authority without consuming the proof",
  async (_scenario, client, request) => {
    const issued = issue();
    expectForbidden(await rpc(issued.proof, client, request));
    expect(issued.wasRedeemed()).toBe(false);
    expect(await rpc(issued.proof)).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ actorId: 101 }),
    );
  },
);

it("expires and releases proofs before the private broker can redeem them", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(0);
  const expired = issue();
  clock.mockReturnValue(60_001);
  expectForbidden(await rpc(expired.proof));
  const released = issue();
  released.release();
  expectForbidden(await rpc(released.proof));
});
