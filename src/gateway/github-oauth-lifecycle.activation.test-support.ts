import { expect, it, type Mock } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import {
  inspectGitHubOAuthRecord,
  readGitHubDeviceAuthorizationRecord,
  writeGitHubOAuthRecord,
  type GitHubIdentityScope,
} from "../agents/github-oauth-records.js";
import { resolveConfiguredGitHubToolIdentity } from "../agents/github-tool-identity.js";
import {
  getRuntimeConfigWriteApplication,
  type RuntimeConfigWriteApplicationClaim,
} from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore as deferred } from "../shared/deferred.js";
import type { createGitHubOAuthLifecycle } from "./github-oauth-lifecycle.js";
import {
  ACCOUNT,
  configForScope,
  configWithSelectedIdentity,
  identity,
  NEW_PROFILE,
  OLD_PROFILE,
  oauthRecord,
  TOKENS,
} from "./github-oauth-lifecycle.test-support.js";

type Lifecycle = ReturnType<typeof createGitHubOAuthLifecycle>;
export function registerGitHubOAuthActivationTests(params: {
  createLifecycle: (options?: { getPersistedConfig?: () => Promise<OpenClawConfig> }) => Lifecycle;
  getConfig: () => OpenClawConfig;
  setConfig: (config: OpenClawConfig) => void;
  advanceToPoll: (requestId: string) => Promise<void>;
  mocks: { pollDeviceToken: Mock; updateConfig: Mock; removeProfile: Mock };
}) {
  const { createLifecycle, getConfig, setConfig, advanceToPoll, mocks } = params;
  const selectedIdentity = (scope: GitHubIdentityScope) =>
    resolveConfiguredGitHubToolIdentity({ config: getConfig(), scope, agentId: "main" });
  const startAuthorization = (lifecycle: Lifecycle, scope: GitHubIdentityScope) =>
    lifecycle.startAuthorization({ scope, agentId: "main" });
  it.each(
    (["system", "agent"] as const).flatMap((scope) =>
      (["delayed", "disabled", "unclaimed"] as const).map((reload) => ({ scope, reload })),
    ),
  )(
    "reports runtime application for $scope OAuth with $reload reload",
    async ({ scope, reload }) => {
      const previous = identity(OLD_PROFILE, { oauth: true, author: true });
      setConfig(configForScope(scope, previous));
      let persisted = getConfig();
      const before = getConfig();
      await writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE, { scope }));
      const saved = deferred<RuntimeConfigWriteApplicationClaim | null>();
      mocks.updateConfig.mockImplementationOnce(async (input) => {
        persisted = configWithSelectedIdentity(before, scope, "main", input.identity);
        const application = getRuntimeConfigWriteApplication(input.writeOptions);
        const claim = reload === "unclaimed" ? null : application!.claim();
        if (reload !== "unclaimed") {
          expect(claim).not.toBeNull();
          if (reload === "disabled") {
            claim!.settle({
              status: "deferred",
              reason: "reload disabled",
              appliesWhen: "reload enabled",
            });
          }
        }
        saved.resolve(claim);
        return persisted;
      });
      const lifecycle = createLifecycle({ getPersistedConfig: async () => persisted });
      const started = await startAuthorization(lifecycle, scope);
      mocks.pollDeviceToken.mockResolvedValue({ status: "authorized", tokens: TOKENS });
      await advanceToPoll(started.requestId);
      const result = lifecycle.pollAuthorization(started.requestId);
      const claim = await awaitGateBeforeSettlement(
        saved.promise,
        result,
        "Authorization settled before config save",
      );
      if (reload === "delayed") {
        expect(await inspectGitHubOAuthRecord(NEW_PROFILE)).toMatchObject({
          state: "valid",
          record: { pendingInitial: { requestId: started.requestId } },
        });
        expect(await readGitHubDeviceAuthorizationRecord(started.requestId)).toBeDefined();
        expect(selectedIdentity(scope)).toEqual(previous);
        setConfig(persisted);
        claim!.settle("applied");
        expect((await result).status).toBe("success");
      } else {
        expect(await result).toEqual({ status: "failed", reason: "config_not_applied" });
        expect(selectedIdentity(scope)).toEqual(previous);
        await lifecycle.maintain();
        expect(await inspectGitHubOAuthRecord(OLD_PROFILE)).toMatchObject({ state: "valid" });
        expect(await inspectGitHubOAuthRecord(NEW_PROFILE)).toMatchObject({
          state: "valid",
          record: { pendingInitial: { requestId: started.requestId } },
        });
        setConfig(persisted);
        await lifecycle.maintain();
      }
      expect(await inspectGitHubOAuthRecord(NEW_PROFILE)).toMatchObject({
        state: "valid",
        record: expect.not.objectContaining({ pendingInitial: expect.anything() }),
      });
      expect(await inspectGitHubOAuthRecord(OLD_PROFILE)).toEqual({ state: "missing" });
      expect(mocks.removeProfile).not.toHaveBeenCalled();
    },
  );

  it.each(["system", "agent"] as const)(
    "preserves custom Git author data when reconnecting %s",
    async (scope) => {
      const previous = identity(OLD_PROFILE, { oauth: true, author: true });
      setConfig(configForScope(scope, previous));
      const lifecycle = createLifecycle();
      const started = await startAuthorization(lifecycle, scope);
      mocks.pollDeviceToken.mockResolvedValue({ status: "authorized", tokens: TOKENS });
      await advanceToPoll(started.requestId);

      await lifecycle.pollAuthorization(started.requestId);

      expect(selectedIdentity(scope)).toEqual({
        profileId: NEW_PROFILE,
        kind: "oauth",
        gitAuthor: previous.gitAuthor,
      });
    },
  );

  it.each(["commit", "wrong account", "path changed", "write failure"] as const)(
    "retains the requested atomic agent activation across restart: %s",
    async (outcome) => {
      const previous = identity(OLD_PROFILE, { oauth: true, author: true });
      setConfig(configForScope("agent", previous));
      const retained = getConfig();
      const activation = {
        expectedAccountId: outcome === "wrong account" ? ACCOUNT.accountId + 1 : ACCOUNT.accountId,
        resetGitAuthor: true as const,
        pathPrepend: ["/agent/bin"],
      };
      const lifecycle = createLifecycle();
      const started = await lifecycle.startAuthorization({
        scope: "agent",
        agentId: "main",
        activation,
      });
      expect(await readGitHubDeviceAuthorizationRecord(started.requestId)).toMatchObject({
        activation,
        expectedPathPrepend: null,
      });
      await lifecycle.stop();
      const restarted = createLifecycle();
      mocks.pollDeviceToken.mockResolvedValue({ status: "authorized", tokens: TOKENS });
      await advanceToPoll(started.requestId);
      if (outcome === "path changed") {
        const changed = structuredClone(getConfig());
        changed.agents!.entries!.main!.tools!.exec = { pathPrepend: ["/other/bin"] };
        setConfig(changed);
      }
      if (outcome === "write failure") {
        mocks.updateConfig.mockRejectedValueOnce(new Error("write failed"));
      }
      const result = await restarted.pollAuthorization(started.requestId);
      if (outcome === "commit") {
        expect(result.status).toBe("success");
        expect(mocks.updateConfig).toHaveBeenCalledExactlyOnceWith({
          scope: "agent",
          agentId: "main",
          identity: {
            profileId: NEW_PROFILE,
            kind: "oauth",
            gitAuthor: {
              name: ACCOUNT.login,
              email: `${ACCOUNT.accountId}+${ACCOUNT.login}@users.noreply.github.com`,
            },
          },
          expectedIdentity: previous,
          writeOptions: expect.any(Object),
          agentLifecycleBinding: { agentId: "main", provenance: null },
          pathPrepend: { expected: null, value: ["/agent/bin"] },
        });
      } else {
        expect(result).toEqual({
          status: "failed",
          reason: outcome === "path changed" ? "identity_changed" : "setup_failed",
        });
        expect(selectedIdentity("agent")).toEqual(previous);
        expect(await inspectGitHubOAuthRecord(NEW_PROFILE)).toMatchObject({ state: "missing" });
        if (outcome !== "write failure") {
          expect(mocks.updateConfig).not.toHaveBeenCalled();
        }
      }
      expect(retained.agents?.entries?.main?.tools?.github).toEqual(previous);
      expect(retained.agents?.entries?.main?.tools?.exec).toBeUndefined();
      expect(getConfig().tools).toEqual(retained.tools);
      expect(await readGitHubDeviceAuthorizationRecord(started.requestId)).toBeUndefined();
    },
  );
}
