import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createNonExitingRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { stageProviderAuthCandidate } from "./setup-inference-credentials.js";

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
});

describe("setup inference credential provider lifetime", () => {
  it.each(
    (["managed wizard", "app-guided auth"] as const).flatMap((flow) =>
      (["empty", "matching-last", "missing-match"] as const).map((profileCase) => ({
        flow,
        profileCase,
      })),
    ),
  )(
    "materializes $flow model normalization with $profileCase profiles before retiring the provider",
    async ({ flow, profileCase }) => {
      await withOpenClawTestState({ label: "setup-plan-lifetime" }, async (state) => {
        const id = flow === "managed wizard" ? "managed-plan" : "guided-plan";
        const pluginDir = state.path(id);
        const nativeEvent = `${id}-native`;
        const observationEvent = `${id}-observation`;
        const rawModelRef = `${id}/preview`;
        const canonicalModelRef = `${id}/canonical`;
        const profiles =
          profileCase === "empty"
            ? []
            : [
                {
                  profileId: "unrelated:default",
                  credential: {
                    type: "api_key",
                    provider: "unrelated",
                    key: "synthetic-unrelated-key",
                  },
                },
                ...(profileCase === "matching-last"
                  ? [
                      {
                        profileId: `${id}:default`,
                        credential: {
                          type: "api_key",
                          provider: id,
                          key: "synthetic-selected-key",
                        },
                      },
                    ]
                  : []),
              ];
        const nativeBefore = process.listenerCount(nativeEvent);
        const observations: Array<{ phase: string; value: unknown }> = [];
        const observe = (phase: string, value: unknown) => {
          observations.push({ phase, value });
        };
        await fs.mkdir(pluginDir);
        await fs.writeFile(
          path.join(pluginDir, "package.json"),
          JSON.stringify({
            name: `@example/${id}`,
            version: "1.0.0",
            type: "commonjs",
            openclaw: { extensions: ["./index.cjs"], setupEntry: "./index.cjs" },
          }),
        );
        await fs.writeFile(
          path.join(pluginDir, "openclaw.plugin.json"),
          JSON.stringify({
            id,
            providers: [id],
            configSchema: { type: "object", properties: {} },
            setup: { requiresRuntime: true, providers: [{ id }] },
            providerAuthChoices: [
              {
                provider: id,
                method: "synthetic",
                choiceId: id,
                choiceLabel: "Synthetic setup",
                ...(flow === "app-guided auth" ? { appGuidedAuth: "oauth" } : {}),
              },
            ],
          }),
        );
        await fs.writeFile(
          path.join(pluginDir, "index.cjs"),
          `
          const nativeEvent = ${JSON.stringify(nativeEvent)};
          const observationEvent = ${JSON.stringify(observationEvent)};
          const listener = () => {};
          process.on(nativeEvent, listener);
          module.exports = { id: ${JSON.stringify(id)}, register(api) {
            api.lifecycle.onDispose(() => {
              process.off(nativeEvent, listener);
              process.emit(observationEvent, "dispose");
            });
            api.registerProvider({
              id: ${JSON.stringify(id)}, label: "Synthetic setup",
              normalizeModelId({ modelId }) {
                process.emit(observationEvent, "normalize", {
                  modelId, listenerLive: process.listenerCount(nativeEvent) > 0,
                  aborted: api.lifecycle.signal.aborted,
                });
                return modelId === "preview" ? "canonical" : modelId;
              },
              auth: [{
                id: "synthetic", label: "Synthetic", kind: "oauth",
                wizard: { choiceId: ${JSON.stringify(id)} },
                async run(ctx) {
                  await ctx.prompter.note("auth entered", "Synthetic setup");
                  const result = {
                    profiles: ${JSON.stringify(profiles)}, defaultModel: ${JSON.stringify(rawModelRef)},
                    configPatch: { agents: { defaults: { models: {
                      [${JSON.stringify(rawModelRef)}]: { alias: "Starter" },
                    } } } },
                  };
                  process.emit(observationEvent, "auth-result", result.defaultModel);
                  return result;
                },
              }],
            });
          } };
          `,
        );
        const cfg: OpenClawConfig = {
          agents: { defaults: { model: { primary: "existing/model" } } },
          plugins: {
            allow: [id],
            load: { paths: [pluginDir] },
            entries: { [id]: { enabled: true } },
            slots: { memory: "none" },
          },
        };
        const originalConfig = structuredClone(cfg);
        await state.writeConfig(cfg);
        const snapshot = await readConfigFileSnapshot();
        const started = createDeferredCore();
        const release = createDeferredCore();
        let entered = false;
        process.on(observationEvent, observe);
        const work = stageProviderAuthCandidate(
          {
            cfg,
            snapshot,
            routeAgentId: "main",
            workspace: state.workspaceDir,
            agentDir: state.agentDir(),
            credentialsSaved: false,
            beforePersistentEffect: async () => {},
            deps: {},
            params: {
              kind: "provider-auth",
              authChoice: id,
              surface: "gateway",
              runtime: createNonExitingRuntime(),
              isRemoteProviderAuth: true,
              prompter: createWizardPrompter({
                note: async (message) => {
                  if (message === "auth entered") {
                    entered = true;
                    started.resolve();
                    await release.promise;
                  }
                },
                confirm: async () => true,
                select: async (params) => {
                  const selected =
                    params.options.find((option) => option.value === true) ?? params.options[0];
                  if (!selected) {
                    throw new Error("Synthetic setup prompt had no choices");
                  }
                  return selected.value;
                },
              }),
            },
          },
          true,
        );
        try {
          await Promise.race([started.promise, work]);
          expect(entered).toBe(true);
          expect(process.listenerCount(nativeEvent)).toBe(nativeBefore + 1);
          // Acquire from the test context so this cannot reuse the provider's inherited lease.
          await withPluginLifecycleLease({ env: state.env, waitMs: 0 }, async (lease) =>
            lease.assertOwned(),
          );
          release.resolve();
          const plan = await work;
          expect(process.listenerCount(nativeEvent)).toBe(nativeBefore);
          expect(cfg).toEqual(originalConfig);
          expect(structuredClone(plan)).toEqual(plan);
          if (profileCase === "missing-match") {
            expect(plan).toEqual({ error: expect.stringContaining("did not return credentials") });
            expect(observations[0]).toEqual({ phase: "auth-result", value: rawModelRef });
            expect(observations.at(-1)).toEqual({ phase: "dispose", value: undefined });
            return;
          }
          expect(observations).toEqual([
            { phase: "auth-result", value: rawModelRef },
            {
              phase: "normalize",
              value: { modelId: "preview", listenerLive: true, aborted: false },
            },
            { phase: "dispose", value: undefined },
          ]);
          expect(plan).toMatchObject({
            modelRef: canonicalModelRef,
            config: {
              agents: {
                defaults: {
                  model: { primary: "existing/model" },
                  models: { [canonicalModelRef]: { alias: "Starter" } },
                },
              },
            },
          });
          if ("error" in plan) {
            throw new Error(plan.error);
          }
          const saved = loadAuthProfileStoreWithoutExternalProfiles(state.agentDir()).profiles;
          if (profileCase === "matching-last") {
            expect(plan.authProfileId).toBeDefined();
            expect(saved[plan.authProfileId!]).toMatchObject(
              expectDefined(profiles[1]?.credential, "Expected the selected fixture credential"),
            );
          } else {
            expect(plan.authProfileId).toBeUndefined();
            expect(saved).toEqual({});
          }
        } finally {
          release.resolve();
          try {
            await work;
          } finally {
            process.off(observationEvent, observe);
          }
        }
      });
    },
  );
});
