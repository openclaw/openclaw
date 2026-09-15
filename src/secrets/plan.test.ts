/** Tests secrets plan normalization, target validation, and ref conversion. */
import { beforeAll, describe, expect, it } from "vitest";
import {
  INVALID_EXEC_SECRET_REF_IDS,
  VALID_EXEC_SECRET_REF_IDS,
} from "../test-utils/secret-ref-test-vectors.js";
import {
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS,
  TALK_TEST_PROVIDER_ID,
} from "../test-utils/talk-test-provider.js";
import {
  SECRETS_PLAN_PROTOCOL_VERSION,
  SECRETS_PLAN_SHARED_PROTOCOL_VERSION,
  isSecretsApplyPlan,
  resolveValidatedPlanTarget,
} from "./plan.js";
import { resolveConfigSecretTargetByPath } from "./target-registry.js";

type ValidatedPlanTarget = NonNullable<ReturnType<typeof resolveValidatedPlanTarget>>;

function requireValidatedPlanTarget(
  resolved: ReturnType<typeof resolveValidatedPlanTarget>,
): ValidatedPlanTarget {
  if (!resolved) {
    throw new Error("expected validated secrets plan target");
  }
  return resolved;
}

/** Builds a one-target auth-profile plan for owner/revision validation cases. */
function buildPlan(params: { protocolVersion: number; authProfileStore?: string }) {
  return {
    version: 1,
    protocolVersion: params.protocolVersion,
    generatedAt: "2026-02-28T00:00:00.000Z",
    generatedBy: "manual",
    targets: [
      Object.assign(
        {
          type: "auth-profiles.api_key.key",
          path: "profiles.openai:default.key",
          pathSegments: ["profiles", "openai:default", "key"],
          agentId: "main",
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
        params.authProfileStore === undefined ? {} : { authProfileStore: params.authProfileStore },
      ),
    ],
  };
}

/**
 * Released v2026.9.4 plan validation: `version`/`protocolVersion` had to be 1 and
 * `authProfileStore` did not exist, so a shared-store target was accepted there and
 * applied to the agent database. Kept so the encoding stays rejectable by that reader.
 */
function isReleasedV2026094Plan(value: unknown): boolean {
  const typed = value as { version?: unknown; protocolVersion?: unknown; targets?: unknown };
  return typed.version === 1 && typed.protocolVersion === 1 && Array.isArray(typed.targets);
}

describe("secrets plan validation", () => {
  beforeAll(() => {
    resolveConfigSecretTargetByPath(["channels", "telegram", "botToken"]);
  });

  it("accepts legacy provider target types", () => {
    const resolved = resolveValidatedPlanTarget({
      type: "models.providers.apiKey",
      path: "models.providers.openai.apiKey",
      pathSegments: ["models", "providers", "openai", "apiKey"],
      providerId: "openai",
    });
    expect(requireValidatedPlanTarget(resolved).pathSegments).toEqual([
      "models",
      "providers",
      "openai",
      "apiKey",
    ]);
  });

  it("accepts expanded target types beyond legacy surface", () => {
    const resolved = resolveValidatedPlanTarget({
      type: "channels.telegram.botToken",
      path: "channels.telegram.botToken",
      pathSegments: ["channels", "telegram", "botToken"],
    });
    expect(requireValidatedPlanTarget(resolved).pathSegments).toEqual([
      "channels",
      "telegram",
      "botToken",
    ]);
  });

  it("accepts model provider header targets with wildcard-backed paths", () => {
    const resolved = resolveValidatedPlanTarget({
      type: "models.providers.headers",
      path: "models.providers.openai.headers.x-api-key",
      pathSegments: ["models", "providers", "openai", "headers", "x-api-key"],
      providerId: "openai",
    });
    expect(requireValidatedPlanTarget(resolved).pathSegments).toEqual([
      "models",
      "providers",
      "openai",
      "headers",
      "x-api-key",
    ]);
  });

  it("rejects target paths that do not match the registered shape", () => {
    const resolved = resolveValidatedPlanTarget({
      type: "channels.telegram.botToken",
      path: "channels.telegram.webhookSecret",
      pathSegments: ["channels", "telegram", "webhookSecret"],
    });
    expect(resolved).toBeNull();
  });

  it("rejects path-like channel ids without throwing", () => {
    expect(
      resolveValidatedPlanTarget({
        type: "channels.foo/bar.token",
        path: "channels.foo/bar.token",
        pathSegments: ["channels", "foo/bar", "token"],
      }),
    ).toBeNull();
  });

  it("validates plan files with non-legacy target types", () => {
    const isValid = isSecretsApplyPlan({
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-02-28T00:00:00.000Z",
      generatedBy: "manual",
      targets: [
        {
          type: "talk.providers.*.apiKey",
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
          providerId: TALK_TEST_PROVIDER_ID,
          ref: { source: "env", provider: "default", id: "TALK_API_KEY" },
        },
      ],
    });
    expect(isValid).toBe(true);
  });

  it("accepts plugin-managed exec provider upserts in plan files", () => {
    const isValid = isSecretsApplyPlan({
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-02-28T00:00:00.000Z",
      generatedBy: "manual",
      providerUpserts: {
        "team-secrets": {
          source: "exec",
          pluginIntegration: {
            pluginId: "acme-secrets",
            integrationId: "secret-store",
          },
        },
      },
      targets: [],
    });
    expect(isValid).toBe(true);
  });

  it("requires agentId for auth-profiles plan targets", () => {
    const withoutAgent = isSecretsApplyPlan({
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-02-28T00:00:00.000Z",
      generatedBy: "manual",
      targets: [
        {
          type: "auth-profiles.api_key.key",
          path: "profiles.openai:default.key",
          pathSegments: ["profiles", "openai:default", "key"],
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
    });
    expect(withoutAgent).toBe(false);

    const withAgent = isSecretsApplyPlan({
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-02-28T00:00:00.000Z",
      generatedBy: "manual",
      targets: [
        {
          type: "auth-profiles.api_key.key",
          path: "profiles.openai:default.key",
          pathSegments: ["profiles", "openai:default", "key"],
          agentId: "main",
          ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      ],
    });
    expect(withAgent).toBe(true);
  });

  it("accepts explicit auth-profile store owners in plan targets", () => {
    for (const authProfileStore of ["agent", "shared"]) {
      const isValid = isSecretsApplyPlan(
        buildPlan({
          protocolVersion:
            authProfileStore === "shared"
              ? SECRETS_PLAN_SHARED_PROTOCOL_VERSION
              : SECRETS_PLAN_PROTOCOL_VERSION,
          authProfileStore,
        }),
      );
      expect(isValid, `expected valid plan owner: ${authProfileStore}`).toBe(true);
    }
  });

  it("requires the shared protocol revision exactly for shared-store targets", () => {
    // Shared ownership must not be encodable in the revision released readers accept,
    // and the shared revision must not appear without a shared target: agent-local
    // plans stay readable by those readers.
    expect(
      isSecretsApplyPlan(
        buildPlan({
          protocolVersion: SECRETS_PLAN_PROTOCOL_VERSION,
          authProfileStore: "shared",
        }),
      ),
    ).toBe(false);
    expect(
      isSecretsApplyPlan(buildPlan({ protocolVersion: SECRETS_PLAN_SHARED_PROTOCOL_VERSION })),
    ).toBe(false);
    expect(
      isSecretsApplyPlan(
        buildPlan({
          protocolVersion: SECRETS_PLAN_SHARED_PROTOCOL_VERSION + 1,
          authProfileStore: "shared",
        }),
      ),
    ).toBe(false);
    expect(
      isSecretsApplyPlan(
        buildPlan({
          protocolVersion: SECRETS_PLAN_PROTOCOL_VERSION,
          authProfileStore: "agent",
        }),
      ),
    ).toBe(true);
  });

  it("emits shared-store plans that the released plan validator rejects", () => {
    // Released v2026.9.4 validation accepted only `protocolVersion: 1` and ignored
    // `authProfileStore`, so it applied a shared-store plan to the agent database and
    // reported success. The shared revision is what turns that into a rejection.
    expect(
      isReleasedV2026094Plan(
        buildPlan({ protocolVersion: SECRETS_PLAN_PROTOCOL_VERSION, authProfileStore: "agent" }),
      ),
    ).toBe(true);
    expect(
      isReleasedV2026094Plan(
        buildPlan({
          protocolVersion: SECRETS_PLAN_SHARED_PROTOCOL_VERSION,
          authProfileStore: "shared",
        }),
      ),
    ).toBe(false);
  });

  it("rejects unknown auth-profile store owners in plan targets", () => {
    for (const authProfileStore of ["main", "", "SHARED"]) {
      const isValid = isSecretsApplyPlan({
        version: 1,
        protocolVersion: 1,
        generatedAt: "2026-02-28T00:00:00.000Z",
        generatedBy: "manual",
        targets: [
          {
            type: "auth-profiles.api_key.key",
            path: "profiles.openai:default.key",
            pathSegments: ["profiles", "openai:default", "key"],
            agentId: "main",
            authProfileStore,
            ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        ],
      });
      expect(isValid, `expected invalid plan owner: ${authProfileStore}`).toBe(false);
    }
  });

  it("accepts valid exec secret ref ids in plans", () => {
    for (const id of VALID_EXEC_SECRET_REF_IDS) {
      const isValid = isSecretsApplyPlan({
        version: 1,
        protocolVersion: 1,
        generatedAt: "2026-03-10T00:00:00.000Z",
        generatedBy: "manual",
        targets: [
          {
            type: "talk.providers.*.apiKey",
            path: TALK_TEST_PROVIDER_API_KEY_PATH,
            pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
            providerId: TALK_TEST_PROVIDER_ID,
            ref: { source: "exec", provider: "vault", id },
          },
        ],
      });
      expect(isValid, `expected valid plan exec ref id: ${id}`).toBe(true);
    }
  });

  it("rejects invalid exec secret ref ids in plans", () => {
    for (const id of INVALID_EXEC_SECRET_REF_IDS) {
      const isValid = isSecretsApplyPlan({
        version: 1,
        protocolVersion: 1,
        generatedAt: "2026-03-10T00:00:00.000Z",
        generatedBy: "manual",
        targets: [
          {
            type: "talk.providers.*.apiKey",
            path: TALK_TEST_PROVIDER_API_KEY_PATH,
            pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
            providerId: TALK_TEST_PROVIDER_ID,
            ref: { source: "exec", provider: "vault", id },
          },
        ],
      });
      expect(isValid, `expected invalid plan exec ref id: ${id}`).toBe(false);
    }
  });
});
