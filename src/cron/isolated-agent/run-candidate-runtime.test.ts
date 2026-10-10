// This covers prepared candidate DTOs, not scheduler admission or persisted-row refresh.
import { describe, expect, it } from "vitest";
import {
  bindConfiguredModelAuthProfileScope,
  replaceRuntimeAuthProfileSelection,
} from "../../config/sessions/auth-profile-override-provenance.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { prepareCronCandidateAuthSelection } from "./run-candidate-runtime.js";

type CandidateParams = Parameters<typeof prepareCronCandidateAuthSelection>[0];

const profileId = "openai:configured";
const workspaceDir = "/tmp/cron-auth-projection-fixture";
const metadataSnapshot = {
  ...createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "fixture-openai-alias",
        providers: ["openai-shadow"],
        providerAuthAliases: { "openai-shadow": "openai" },
      },
    ],
  }),
  workspaceDir,
};

function makeParams(configured: boolean): CandidateParams {
  const sessionEntry = { sessionId: "cron-auth-session", updatedAt: 1 };
  const params: CandidateParams = {
    cfgWithAgentDefaults: {},
    workspaceDir,
    liveSelection: {
      provider: "openai",
      model: "primary-model",
      authProfileId: profileId,
      authProfileIdSource: "user",
    },
    cronSession: {
      sessionEntry,
      store: { "cron-auth-key": sessionEntry },
      storePath: "/tmp/cron-auth-projection-fixture/sessions.sqlite",
      lifecycleRevision: "11111111-1111-4111-8111-111111111111",
      systemSent: false,
      isNewSession: false,
      previousSessionId: undefined,
      resetBoundaryPending: undefined,
      initialSessionEntry: undefined,
    },
  };
  if (configured) {
    bindConfiguredModelAuthProfileScope(params.liveSelection, "openai");
  }
  return params;
}

const retained = {
  embedded: { authProfileId: profileId, authProfileIdSource: "user" },
  cli: { authProfileId: profileId, authProfileIdSource: "user" },
};
const unselected = {
  embedded: { authProfileId: undefined, authProfileIdSource: undefined },
  cli: undefined,
};

describe("prepared cron candidate account selection", () => {
  it.each([
    { provider: "anthropic", expected: unselected },
    { provider: "openai", expected: retained },
    { provider: "openai-shadow", expected: retained },
  ])("scopes a configured primary account for $provider", ({ provider, expected }) => {
    withPluginRuntimeGenerationScope({ metadataSnapshot }, () => {
      const params = makeParams(true);
      const readSelection = prepareCronCandidateAuthSelection(params, provider);

      expect(readSelection()).toEqual(expected);
      expect(params.liveSelection.authProfileId).toBe(profileId);
      expect(params.liveSelection.authProfileIdSource).toBe("user");
    });
  });

  it("keeps the original configured account scope after a fallback wins", () => {
    withPluginRuntimeGenerationScope({ metadataSnapshot }, () => {
      const params = makeParams(true);
      expect(prepareCronCandidateAuthSelection(params, "anthropic")()).toEqual(unselected);

      // Successful cron fallback updates the current route before continuation.
      params.liveSelection.provider = "anthropic";
      params.liveSelection.model = "fallback-model";

      expect(prepareCronCandidateAuthSelection(params, "anthropic")()).toEqual(unselected);
      expect(prepareCronCandidateAuthSelection(params, "openai")()).toEqual(retained);
    });
  });

  it.each(["user", "user-link"] as const)(
    "retains a late same-account %s intent supplied by the session owner",
    (source) => {
      withPluginRuntimeGenerationScope({ metadataSnapshot }, () => {
        const params = makeParams(true);
        const readSelection = prepareCronCandidateAuthSelection(params, "anthropic");
        expect(readSelection()).toEqual(unselected);

        // Supply the owner's current row after candidate preparation; no DB freshness claim.
        params.cronSession.sessionEntry = {
          ...params.cronSession.sessionEntry,
          authProfileOverride: profileId,
          authProfileOverrideSource: source,
        };

        expect(readSelection()).toEqual(retained);
      });
    },
  );

  it("retains a same-value explicit run selection after candidate preparation", () => {
    withPluginRuntimeGenerationScope({ metadataSnapshot }, () => {
      const params = makeParams(true);
      const readSelection = prepareCronCandidateAuthSelection(params, "anthropic");
      expect(readSelection()).toEqual(unselected);

      replaceRuntimeAuthProfileSelection(params.liveSelection, {
        authProfileId: profileId,
        authProfileIdSource: "user",
      });

      expect(readSelection()).toEqual(retained);
    });
  });

  it.each(["payload", "session"] as const)(
    "retains a raw %s account pin for an incompatible candidate",
    (origin) => {
      withPluginRuntimeGenerationScope({ metadataSnapshot }, () => {
        const params = makeParams(false);
        if (origin === "session") {
          params.cronSession.sessionEntry = {
            ...params.cronSession.sessionEntry,
            authProfileOverride: profileId,
            authProfileOverrideSource: "user",
          };
        }

        // The CLI auth owner must receive the pin and retain its incompatibility check.
        expect(prepareCronCandidateAuthSelection(params, "anthropic")()).toEqual(retained);
      });
    },
  );
});
