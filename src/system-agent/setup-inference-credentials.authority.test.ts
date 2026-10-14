import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withTestTimeout,
} from "../../test/helpers/promise.js";
import * as oauthLocks from "../agents/auth-profiles/oauth-profile-lock.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles/store-runtime.js";
import { clearConfigCache } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayClient } from "../gateway/server-methods/client-types.js";
import { modelsAuthLoginHandlers } from "../gateway/server-methods/models-auth-login.js";
import { whenAdmittedWizardSessionSettled } from "../gateway/server-methods/setup-admission.js";
import * as setupExecution from "../gateway/server-methods/system-agent-execution.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { createWizardSessionTracker } from "../gateway/server-wizard-sessions.js";
import * as providerChoices from "../plugins/provider-auth-choices.js";
import { resolvePluginProvidersCore } from "../plugins/providers.runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { fixture, modelRef, tempDirs } from "./setup-inference-activate.test-support.js";
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

describe("native setup authority", () => {
  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    tempDirs.cleanup();
    clearConfigCache();
    vi.unstubAllEnvs();
  });

  it("blocks native Muse login after the admin connection is invalidated without aborting", async () => {
    const setup = await fixture({ surface: "gateway" });
    const binaryPath = path.join(path.dirname(setup.configPath), "muse");
    const attemptsPath = path.join(path.dirname(setup.configPath), "muse-attempts");
    await fs.writeFile(
      binaryPath,
      `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(attemptsPath)}, "spawn\\n");
process.exit(1);
`,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", `${path.dirname(binaryPath)}${path.delimiter}${process.env.PATH ?? ""}`);
    const muse = resolvePluginProvidersCore({
      config: { plugins: { allow: ["meta"], entries: { meta: { enabled: true } } } },
      onlyPluginIds: ["meta"],
      mode: "setup",
      workspaceDir: setup.workspace,
    })
      .find((provider) => provider.id === "meta")
      ?.auth.find((method) => method.id === "muse-code");
    assert.ok(muse, "The real Meta provider must expose Muse sign-in");
    const provider = setup.pluginRegistry.providers[0]?.provider;
    assert.ok(provider?.auth[0]);
    const entered = createDeferred();
    const release = createDeferred();
    let providerSignal: AbortSignal | undefined;
    provider.auth[0].run = async (ctx) => {
      providerSignal = ctx.signal;
      entered.resolve();
      await release.promise;
      return muse.run(ctx);
    };
    vi.spyOn(providerChoices, "resolveManifestDeclaredProviderAuthChoices").mockReturnValue([
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "fixture-login",
        choiceId: "fixture-login",
        choiceLabel: "Fixture sign-in",
        appGuidedAuth: "oauth",
      },
    ]);
    const activate = setupExecution.activateGatewaySetupInference;
    vi.spyOn(setupExecution, "activateGatewaySetupInference").mockImplementation((params) =>
      setup.runWithMetadata(() => activate({ ...params, modelRef, deps: setup.deps })),
    );
    const tracker = createWizardSessionTracker();
    const controller = new AbortController();
    const client: GatewayClient = {
      connId: "native-login-owner",
      connectionSignal: controller.signal,
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        scopes: ["operator.admin"],
        client: { id: "cli", version: "test", platform: "test", mode: "cli" },
      },
    };
    const params = { sessionId: "native-login", authChoice: "openai/fixture-login" };
    const handler = modelsAuthLoginHandlers["models.authLogin"];
    assert.ok(handler);
    try {
      await handler({
        req: { type: "req", id: "native-login", method: "models.authLogin", params },
        params,
        respond: vi.fn(),
        // SAFETY: This handler only uses the real wizard tracker and config reader supplied here.
        context: { ...tracker, getRuntimeConfig: () => setup.config } as GatewayRequestContext,
        client,
        isWebchatConnect: () => false,
      });
      await withTestTimeout(entered.promise, 5_000, "Provider login did not start");
      const session = tracker.wizardSessions.get(params.sessionId);
      assert.ok(session);
      client.invalidated = true;
      expect(controller.signal.aborted).toBe(false);
      expect(providerSignal?.aborted).toBe(false);
      release.resolve();
      await whenAdmittedWizardSessionSettled(session);
      expect(session.getStatus()).toBe("error");
      expect(session.getError()).toContain("authority is no longer active");
      expect(providerSignal?.aborted).toBe(false);
      await expect(fs.stat(attemptsPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(setup.run).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      for (const session of tracker.wizardSessions.values()) {
        session.cancel();
        await whenAdmittedWizardSessionSettled(session);
      }
    }
  });
});
