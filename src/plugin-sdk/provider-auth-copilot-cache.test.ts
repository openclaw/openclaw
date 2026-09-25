import { afterEach, describe, expect, it, vi } from "vitest";
import { COPILOT_INTEGRATION_ID } from "../agents/copilot-dynamic-headers.js";
import * as pluginState from "../plugin-state/plugin-state-store.js";
import { closePluginStateDatabase } from "../plugin-state/plugin-state-store.sqlite.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  fingerprintCopilotSourceCredential,
  resolveCopilotTokenCache,
} from "./provider-auth-copilot-cache.js";
import { resolveCopilotApiToken } from "./provider-auth.js";

afterEach(() => {
  vi.restoreAllMocks();
  pluginState.resetPluginStateStoreForTests();
});

describe("Copilot cache completion", () => {
  it.each(
    (["load", "save"] as const).flatMap((operation) =>
      (["resolve", "reject"] as const).map((outcome) => ({ operation, outcome })),
    ),
  )("awaits cache $operation through $outcome", async ({ operation, outcome }) => {
    await withStateDirEnv("openclaw-copilot-async-", async ({ tempRoot }) => {
      const env = { OPENCLAW_STATE_DIR: tempRoot, COPILOT_GITHUB_DOMAIN: "github.com" };
      const githubToken = "synthetic-github-credential";
      const cache = await resolveCopilotTokenCache({
        env,
        domain: "github.com",
        sourceCredentialFingerprint: fingerprintCopilotSourceCredential(githubToken),
      });
      if (operation === "load") {
        await cache.save({
          token: "synthetic-cached-token",
          expiresAt: Date.now() + 3_600_000,
          updatedAt: Date.now(),
          integrationId: COPILOT_INTEGRATION_ID,
          sourceCredentialFingerprint: fingerprintCopilotSourceCredential(githubToken),
          domain: "github.com",
        });
      }
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const createStore = pluginState.createCorePluginStateKeyedStore;
      vi.spyOn(pluginState, "createCorePluginStateKeyedStore").mockImplementation((options) => {
        const store = createStore(options);
        return {
          ...store,
          lookup: async (...args) => {
            if (operation === "load") {
              entered.resolve();
              await release.promise;
            }
            return store.lookup(...args);
          },
          register: async (...args) => {
            if (operation === "save") {
              entered.resolve();
              await release.promise;
            }
            return store.register(...args);
          },
        };
      });
      const fetchImpl = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              token: "synthetic-exchanged-token",
              expires_at: Math.floor(Date.now() / 1_000) + 3_600,
            }),
          ),
      );
      const pending = resolveCopilotApiToken({ env, githubToken, fetchImpl });
      let completed = false;
      const settle = () => {
        completed = true;
        return "settled";
      };
      const settled = pending.then(settle, settle);
      try {
        expect(await Promise.race([entered.promise.then(() => "waiting"), settled])).toBe(
          "waiting",
        );
        expect(completed).toBe(false);
        expect(fetchImpl).toHaveBeenCalledTimes(operation === "load" ? 0 : 1);
        if (outcome === "reject") {
          const error = new Error("synthetic cache rejection");
          release.reject(error);
          await expect(pending).rejects.toBe(error);
        } else {
          release.resolve();
          await expect(pending).resolves.toMatchObject({
            token: operation === "load" ? "synthetic-cached-token" : "synthetic-exchanged-token",
          });
          closePluginStateDatabase();
          await expect(cache.load()).resolves.toMatchObject({
            token: operation === "load" ? "synthetic-cached-token" : "synthetic-exchanged-token",
          });
        }
      } finally {
        release.resolve();
        await settled;
      }
    });
  });
});
