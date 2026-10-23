import { beforeEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  roleClient,
  rolePolicyConfig,
  sharingPolicyClient,
} from "../session-sharing.test-utils.js";
import {
  ArtifactSessionResolutionError,
  createArtifactSessionAccess,
  prepareArtifactSessionResolution,
  type ArtifactQuery,
} from "./artifacts-session-resolution.js";
import type { GatewayClient } from "./types.js";

type Projection = NonNullable<Parameters<typeof prepareArtifactSessionResolution>[1]>;

const { resolveRunSession } = vi.hoisted(() => ({
  resolveRunSession: vi.fn(),
}));

// mock-isolation: Run selectors use the fixture scope, not the operator's live session catalog.
vi.mock("../server-session-key.js", () => ({ resolveSessionForRun: resolveRunSession }));

async function sessionFixture(
  sessionKey: string,
  entry: Parameters<typeof upsertSessionEntryCore>[1],
  cfg: OpenClawConfig = {},
) {
  setRuntimeConfigSnapshot(cfg);
  const scope = { agentId: "main", sessionKey };
  const row = { sessionId: `session-${sessionKey.split(":").at(-1)}`, updatedAt: 1, ...entry };
  await upsertSessionEntryCore(scope, row);
  resolveRunSession.mockReturnValue(scope);
  const read = async (
    client: GatewayClient | null,
    query: ArtifactQuery = { sessionKey },
    runtimeConfig: OpenClawConfig | undefined = cfg,
  ) => {
    using access = createArtifactSessionAccess({
      getRuntimeConfig: () => runtimeConfig ?? {},
      client,
    });
    const resolve = await prepareArtifactSessionResolution(query);
    return await resolve(access);
  };
  return {
    read,
    allows: (...args: Parameters<typeof read>) =>
      expect(read(...args)).resolves.toMatchObject({ sessionKey }),
  };
}

function identifiedClient(scopes: string[], profileId = "viewer@example.com"): GatewayClient {
  return {
    ...sharingPolicyClient({ user: profileId, scopes }),
    authenticatedUserId: "viewer@example.com",
  };
}

const profileState = { scenario: "minimal", prepareProfileCatalog: true } as const;
const scopeNotFound = {
  message: "no session found for artifact query",
  details: { type: "artifact_scope_not_found" },
};

beforeEach(() => vi.clearAllMocks());

it("waits for indirect artifact topology without waiting for unrelated row enrichment", async () => {
  const unavailable = new Error("session projection is unavailable");
  const projection = {
    sharingRevision: undefined,
    sharingTarget: vi.fn(),
    sharingTargetState: vi.fn(),
    readSource: vi.fn(),
    readMembership: vi.fn(),
    needsMembershipPreparation: vi.fn(),
    prepareMembership: vi.fn(),
    ensureMaterialized: vi.fn<Projection["ensureMaterialized"]>().mockRejectedValue(unavailable),
    findBySessionId: vi.fn<Projection["findBySessionId"]>(),
  } satisfies Projection;
  await expect(
    prepareArtifactSessionResolution({ sessionKey: "agent:main:main" }, projection),
  ).resolves.toBeTypeOf("function");
  expect(projection.ensureMaterialized).not.toHaveBeenCalled();
  await expect(prepareArtifactSessionResolution({ runId: "run-1" }, projection)).rejects.toBe(
    unavailable,
  );
  await expect(
    prepareArtifactSessionResolution({ runId: "run-1" }, { ...projection, sharingRevision: {} }),
  ).resolves.toBeTypeOf("function");
});

it("denies direct and indirect incognito selectors while preserving admin access", async () => {
  await withOpenClawTestState(profileState, async () => {
    const sessionKey = "agent:main:dashboard:incognito-artifacts";
    const cfg = { agents: { entries: { main: {} } } };
    const { read, allows } = await sessionFixture(
      sessionKey,
      {
        incognito: true,
        visibility: "shared",
      },
      cfg,
    );
    const viewer = identifiedClient(["operator.read"]);
    const direct = { sessionKey: "dashboard:incognito-artifacts", agentId: "main" };

    await expect(read(viewer, direct)).rejects.toThrow(
      'Incognito session "dashboard:incognito-artifacts" was not found.',
    );
    await expect(read(viewer, { runId: "run-private" })).rejects.toMatchObject({
      constructor: ArtifactSessionResolutionError,
      shape: scopeNotFound,
    });
    await allows(identifiedClient(["operator.admin"]), direct);
  });
});

it.each([
  ["draft without roles", "draft", {}, undefined],
  ["draft without runtime config", "draft", undefined, undefined],
  ["shared with a none role", "shared", rolePolicyConfig(), "none"],
  ["draft with a write role", "draft", rolePolicyConfig(), "write"],
] as const)(
  "hides %s artifacts behind direct and run selectors",
  async (_name, visibility, cfg, role) => {
    await withOpenClawTestState(profileState, async () => {
      setRuntimeConfigSnapshot(cfg ?? {});
      const viewerProfile = ensureProfileForEmail("viewer@example.com");
      const ownerProfile = ensureProfileForEmail("owner@example.com");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const sessionKey = "agent:main:foreign-artifacts";
      const { read, allows } = await sessionFixture(
        sessionKey,
        {
          createdActor: { type: "human", source: "profile", id: ownerProfile.id },
          visibility,
        },
        cfg,
      );
      const viewer = role
        ? roleClient(role, "artifact-viewer")
        : identifiedClient(["operator.read"], viewerProfile.id);

      for (const query of [{ sessionKey }, { runId: "run-foreign" }]) {
        await expect(read(viewer, query, cfg)).rejects.toThrowError(
          expect.objectContaining({
            shape: { code: "INVALID_REQUEST", ...scopeNotFound },
          }),
        );
      }

      const owner = identifiedClient(["operator.read"], ownerProfile.id);
      const admin = identifiedClient(["operator.admin"], viewerProfile.id);
      await allows(owner, { sessionKey }, cfg);
      await allows(admin, { runId: "run-foreign" }, cfg);
    });
  },
);

it.each(["shared", "read-only", "suggest"] as const)(
  "allows reading foreign %s artifacts without participation",
  async (visibility) => {
    await withOpenClawTestState(profileState, async () => {
      setRuntimeConfigSnapshot({});
      const owner = ensureProfileForEmail("artifact-owner@example.test");
      const viewer = roleClient("view", "artifact-reader");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const sessionKey = "agent:main:readable-artifacts";
      const { allows } = await sessionFixture(sessionKey, {
        createdActor: { type: "human", source: "profile", id: owner.id },
        visibility,
      });

      for (const cfg of [undefined, {}, rolePolicyConfig()]) {
        await allows(viewer, { sessionKey }, cfg);
      }
    });
  },
);

it("preserves solo and system reads while denying identityless reads with roles", async () => {
  await withOpenClawTestState(profileState, async () => {
    const sessionKey = "agent:main:solo-artifacts";
    const { read, allows } = await sessionFixture(sessionKey, {
      visibility: "draft",
    });
    const identityless = sharingPolicyClient({});
    for (const client of [null, identityless, sharingPolicyClient({ user: "gateway-owner" })]) {
      await allows(client);
    }
    const cfg = rolePolicyConfig();
    await expect(read(identityless, { sessionKey }, cfg)).rejects.toThrow(
      "no session found for artifact query",
    );
    const system: GatewayClient = {
      ...identityless,
      internal: { operatorRoleActor: { kind: "system" } },
    };
    await allows(system, { sessionKey }, cfg);
  });
});
