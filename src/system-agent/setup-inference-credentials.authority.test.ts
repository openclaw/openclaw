import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import * as oauthLocks from "../agents/auth-profiles/oauth-profile-lock.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles/store-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  SetupInferenceCancelledError,
  throwIfSetupInferenceCancelled,
} from "./setup-inference-core.js";
import { saveSetupCredential } from "./setup-inference-credentials.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "checks setup authority at the credential transaction after OAuth lock wait (revoked=%s)",
  async (revoke) => {
    await withOpenClawTestState({ label: "setup-credential-authority" }, async (state) => {
      const config: OpenClawConfig = { agents: { entries: { main: {} } } };
      const existing = {
        type: "api_key" as const,
        provider: "fixture",
        key: "existing-fixture-key",
      };
      await state.writeAuthProfiles({ version: 1, profiles: { "fixture:existing": existing } });
      const lockEntered = createDeferred();
      const releaseLock = createDeferred();
      const withLocks = oauthLocks.withOAuthProfileLocks;
      vi.spyOn(oauthLocks, "withOAuthProfileLocks").mockImplementation(
        async (keys, operation, options) => {
          lockEntered.resolve();
          await releaseLock.promise;
          return await withLocks(keys, operation, options);
        },
      );
      let revoked = false;
      const beforePersistentEffect = vi.fn();
      const saving = saveSetupCredential({
        profile: {
          profileId: "openai:codex-cli",
          credential: {
            type: "oauth",
            provider: "openai",
            access: "synthetic-codex-access",
            refresh: "synthetic-codex-refresh",
            expires: 4_102_444_800_000,
            accountId: "synthetic-codex-account",
          },
        },
        config,
        baseConfig: config,
        agentDir: state.agentDir(),
        modelRef: "openai/fixture-model",
        pluginId: "codex",
        beforePersistentEffect,
        beforeWrite: () => throwIfSetupInferenceCancelled({ isCancelled: () => revoked }),
      });
      const settled = saving.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await awaitGateBeforeSettlement(
          lockEntered.promise,
          settled,
          "credential did not reach OAuth lock",
        );
        expect(beforePersistentEffect).toHaveBeenCalledOnce();
        revoked = revoke;
        releaseLock.resolve();
        const outcome = await settled;
        const stored = (await loadAuthProfileStoreWithoutExternalProfilesAsync(state.agentDir()))
          .profiles;
        expect(stored["fixture:existing"]).toEqual(existing);
        if (revoke) {
          expect(outcome).toMatchObject({
            ok: false,
            error: expect.any(SetupInferenceCancelledError),
          });
          expect(Object.keys(stored)).toEqual(["fixture:existing"]);
        } else {
          expect(outcome.ok).toBe(true);
          if (!outcome.ok) {
            throw outcome.error;
          }
          expect(stored[outcome.value.profile.profileId]).toMatchObject({
            type: "oauth",
            provider: "openai",
            access: "synthetic-codex-access",
            setup: { modelRef: "openai/fixture-model", pluginId: "codex" },
          });
        }
      } finally {
        releaseLock.resolve();
        await settled;
      }
    });
  },
);
