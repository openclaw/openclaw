import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as nativeIdentity from "../../agents/github-read-identity.js";
import { ensureCanonicalUserProfileForEmail } from "../../state/user-profile-writes.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { factoryGitHubActorEnvironment } from "../factory-github-actor.js";
import {
  factoryGitHubClientProof,
  issueFactoryGitHubProof,
  readFactoryGitHubToken,
} from "../factory-github-proof.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createOperatorClient } from "../server-plugin-in-process-dispatch.test-support.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const claim = {
  purpose: "publication-execution" as const,
  binding: {
    kind: "publication" as const,
    agentId: "main",
    sessionKey: "agent:main:room",
    sessionId: "session-1",
    lifecycleRevision: "revision-1",
    executionKind: "worktree" as const,
    requestId: "request-1",
    ownerId: "gateway-1:run-1",
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

it("redeems the exact execution once through the registered direct private method", async () => {
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
      purpose: "publication-execution",
      actorId: 101,
      actorPrincipal: "github:microsoft.ghe.com:101",
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

it("binds authenticated read-only item previews without granting publication authority", async () => {
  vi.stubEnv("FACTORY_AUTH_MODE", "github");
  const client = createOperatorClient({ profileId: "person-read", scopes: ["operator.read"] });
  client.authenticatedFactoryGitHubAccountId = 1358766;
  client.internal = { authenticatedOperator: true };
  expect(
    factoryGitHubActorEnvironment(client, "agent:main:room", "session-item-read"),
  ).toMatchObject({
    OPENCLAW_FACTORY_ACTOR_ID: "1358766",
    OPENCLAW_FACTORY_SESSION_KEY: "agent:main:room",
    GH_TOKEN: undefined,
    GH_ENTERPRISE_TOKEN: undefined,
  });
  expect(() => factoryGitHubActorEnvironment(client, "agent:main:room")).toThrow();
  let current = true;
  const read = {
    purpose: "session-item-read" as const,
    binding: {
      kind: "session" as const,
      agentId: "main",
      sessionKey: "agent:main:room",
      sessionId: "session-read",
      lifecycleRevision: "revision-read",
      requestDigest: "b".repeat(64),
    },
  };
  const proofInput = factoryGitHubClientProof({
    client,
    claim: read,
    assertCurrent: () => {
      if (!current) {
        throw new Error("Original item access revoked");
      }
    },
  });
  const issued = issueFactoryGitHubProof(proofInput);
  expect(await rpc(issued.proof)).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      purpose: "session-item-read",
      actorId: 1358766,
      profileId: "person-read",
      binding: read.binding,
    }),
  );
  expect(await rpc(issued.proof)).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
  expect(() => factoryGitHubClientProof({ client, claim, assertCurrent: () => {} })).toThrow();
  const revoked = issueFactoryGitHubProof(proofInput);
  current = false;
  expect(await rpc(revoked.proof)).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
  current = true;
  client.internal.syntheticClient = true;
  expect(() =>
    factoryGitHubClientProof({ client, claim: read, assertCurrent: () => {} }),
  ).toThrow();
});

it.each([
  { purpose: "session-dispatch-project", kind: "session-dispatch" },
  { purpose: "session-issue-read", kind: "session" },
] as const)(
  "redeems $purpose once with the exact session and source digest",
  async ({ purpose, kind }) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    const binding = {
      kind,
      agentId: "main",
      sessionKey: "agent:main:room",
      sessionId: "session-2",
      lifecycleRevision: null,
      requestDigest: "a".repeat(64),
    };
    const issued = issueFactoryGitHubProof({
      actorId: 202,
      profileId: "person-2",
      claim:
        purpose === "session-issue-read"
          ? { purpose, binding: { ...binding, kind: "session" } }
          : { purpose, binding: { ...binding, kind: "session-dispatch" } },
      assertCurrent: () => {},
    });
    expect(await rpc(issued.proof)).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        purpose,
        actorId: 202,
        actorPrincipal: "github:microsoft.ghe.com:202",
        profileId: "person-2",
        binding,
      }),
    );
    expect(await rpc(issued.proof)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  },
);

it.each([
  ["proxied loopback", { internal: { authenticatedOperator: true } }, {}],
  ["invalidated client", { invalidated: true }, {}],
  ["revoked authority", {}, { hasCurrentClientAuthority: () => false }],
] satisfies [
  string,
  Partial<GatewayClient>,
  Partial<Pick<GatewayRequestHandlerOptions, "hasCurrentClientAuthority" | "signal">>,
][])("rejects a %s caller without consuming its proof", async (_label, client, request) => {
  vi.stubEnv("FACTORY_AUTH_MODE", "github");
  const issued = issueFactoryGitHubProof({
    actorId: 101,
    profileId: "person-1",
    claim,
    assertCurrent: () => {},
  });
  expect(await rpc(issued.proof, client, request)).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
  expect(await rpc(issued.proof)).toHaveBeenCalledWith(true, expect.any(Object));
});

it("consumes stale or expired proof without returning actor authority", async () => {
  vi.stubEnv("FACTORY_AUTH_MODE", "github");
  let current = true;
  const stale = issueFactoryGitHubProof({
    actorId: 101,
    profileId: "person-1",
    claim,
    assertCurrent: () => {
      if (!current) {
        throw new Error("role or session changed");
      }
    },
  });
  current = false;
  expect(await rpc(stale.proof)).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
  current = true;
  expect(await rpc(stale.proof)).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const expired = issueFactoryGitHubProof({
    actorId: 101,
    profileId: "person-1",
    claim,
    assertCurrent: () => {},
  });
  clock.mockReturnValue(now + 60_000);
  expect(await rpc(expired.proof)).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
});

it("rejects an actor change after the authenticated client was captured", () => {
  const client = brokerClient({
    authenticatedFactoryGitHubAccountId: 101,
    authenticatedUserProfile: {
      profileId: "person-1",
      displayName: null,
      hasAvatar: false,
      updatedAt: 0,
    },
  });
  const input = factoryGitHubClientProof({
    client,
    claim: {
      purpose: "project-add",
      binding: { kind: "connection", connectionId: "connection-1", requestDigest: "digest-1" },
    },
    assertCurrent: () => {},
  });
  client.authenticatedFactoryGitHubAccountId = 202;
  expect(input.assertCurrent).toThrow("authority changed");
});

describe("native broker lookup", () => {
  let state: OpenClawTestState;
  let profileId: string;
  beforeAll(async () => {
    state = await createOpenClawTestState({
      label: "factory-proof",
      layout: "state-only",
      applyEnv: false,
    });
    profileId = (
      await ensureCanonicalUserProfileForEmail("github:microsoft.ghe.com:101", {
        env: state.env,
      })
    ).id;
  });
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", state.stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", state.configPath);
  });
  afterAll(async () => {
    await state?.cleanup();
  });

  it("rejects a native token returned without broker redemption", async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    vi.spyOn(nativeIdentity, "readNativeGitHubToken").mockResolvedValue("ambient-token");
    await expect(
      readFactoryGitHubToken(
        { GH_TOKEN: "ambient-token" },
        { actorId: 101, profileId, claim, assertCurrent: () => {} },
      ),
    ).rejects.toThrow("did not authorize");
  });

  it("does not mistake expiry pruning for broker redemption", async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    vi.spyOn(nativeIdentity, "readNativeGitHubToken").mockImplementation(async () => {
      clock.mockReturnValue(now + 60_000);
      issueFactoryGitHubProof({
        actorId: 101,
        profileId,
        claim,
        assertCurrent: () => {},
      }).release();
      return "unbrokered-token";
    });
    await expect(
      readFactoryGitHubToken({}, { actorId: 101, profileId, claim, assertCurrent: () => {} }),
    ).rejects.toThrow("did not authorize");
  });

  it("drops a redeemed token if the original authority closes before lookup settles", async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    let current = true;
    vi.spyOn(nativeIdentity, "readNativeGitHubToken").mockImplementation(async (env) => {
      await rpc(env.OPENCLAW_FACTORY_GITHUB_PROOF ?? "");
      current = false;
      return "broker-token";
    });
    await expect(
      readFactoryGitHubToken(
        {},
        {
          actorId: 101,
          profileId,
          claim,
          assertCurrent: () => {
            if (!current) {
              throw new Error("publication authority closed");
            }
          },
        },
      ),
    ).rejects.toThrow("publication authority closed");
  });
});
