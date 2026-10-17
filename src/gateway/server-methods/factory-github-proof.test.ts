import { afterEach, expect, it, vi } from "vitest";
import { issueFactoryGitHubProof } from "../factory-github-proof.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./types.js";

vi.mock("../../agents/github-host-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/github-host-runtime.js")>()),
  resolveGitHubHost: () => "example.ghe.com",
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

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

function brokerClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
  return {
    connId: "broker-connection",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "cli", version: "test", platform: "test", mode: "cli" },
      role: "operator",
      scopes: ["operator.admin"],
    },
    internal: {
      isLocalClient: true,
      authenticatedOperator: true,
      operatorRoleActor: { kind: "system" },
    },
    ...overrides,
  };
}

async function rpc(
  proof: string,
  clientOverrides: Partial<GatewayClient> = {},
  requestOverrides: Partial<
    Pick<GatewayRequestHandlerOptions, "hasCurrentClientAuthority" | "signal">
  > = {},
) {
  const respond = vi.fn();
  await coreGatewayHandlers["factory.githubPublication.redeem"]?.({
    client: brokerClient(clientOverrides),
    context: createDirectChatContext({ isConnectionActive: () => true }),
    req: {
      type: "req",
      id: "proof-request",
      method: "factory.githubPublication.redeem",
      params: { proof },
    },
    isWebchatConnect: () => false,
    params: { proof },
    respond,
    hasCurrentClientAuthority: () => true,
    ...requestOverrides,
  });
  return respond;
}

it("redeems the exact session read once through the registered direct private method", async () => {
  vi.stubEnv("FACTORY_AUTH_MODE", "github");
  const issued = issueFactoryGitHubProof({
    actorId: 101,
    profileId: "person-1",
    claim,
    assertCurrent: () => {},
  });
  const first = await rpc(issued.proof);
  expect(first).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      purpose: "session-item-read",
      actorId: 101,
      actorPrincipal: "github:example.ghe.com:101",
      profileId: "person-1",
      binding: claim.binding,
    }),
  );
  expect(await rpc(issued.proof)).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
});

it("rejects public proxy connections and revoked original authority", async () => {
  vi.stubEnv("FACTORY_AUTH_MODE", "github");
  let current = true;
  const issued = issueFactoryGitHubProof({
    actorId: 101,
    profileId: "person-1",
    claim,
    assertCurrent: () => {
      if (!current) {
        throw new Error("Original caller revoked");
      }
    },
  });
  try {
    expect(
      await rpc(issued.proof, {
        internal: { authenticatedOperator: true, operatorRoleActor: { kind: "system" } },
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "FORBIDDEN" }));
    current = false;
    expect(await rpc(issued.proof)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    current = true;
    expect(await rpc(issued.proof)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  } finally {
    issued.release();
  }
});

it.each(["non-admin", "non-system", "retired", "aborted"] as const)(
  "refuses broker redemption with %s authority without consuming the proof",
  async (scenario) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    const issued = issueFactoryGitHubProof({
      actorId: 101,
      profileId: "person-1",
      claim,
      assertCurrent() {},
    });
    try {
      const client = brokerClient();
      const request: Parameters<typeof rpc>[2] = {};
      if (scenario === "non-admin") {
        client.connect.scopes = ["operator.read"];
      }
      if (scenario === "non-system") {
        client.internal = {
          ...client.internal,
          operatorRoleActor: { kind: "operator", profileId: "person-1" },
        };
      }
      if (scenario === "retired") {
        request.hasCurrentClientAuthority = () => false;
      }
      if (scenario === "aborted") {
        request.signal = AbortSignal.abort();
      }
      expect(await rpc(issued.proof, client, request)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
      expect(issued.wasRedeemed()).toBe(false);
      expect(await rpc(issued.proof)).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ actorId: 101 }),
      );
    } finally {
      issued.release();
    }
  },
);

it("expires and releases proofs before the private broker can redeem them", async () => {
  vi.stubEnv("FACTORY_AUTH_MODE", "github");
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const expired = issueFactoryGitHubProof({
      actorId: 101,
      profileId: "person-1",
      claim,
      assertCurrent() {},
    });
    clock.mockReturnValue(now + 60_001);
    expect(await rpc(expired.proof)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    const released = issueFactoryGitHubProof({
      actorId: 101,
      profileId: "person-1",
      claim,
      assertCurrent() {},
    });
    released.release();
    expect(await rpc(released.proof)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  } finally {
    clock.mockRestore();
  }
});
