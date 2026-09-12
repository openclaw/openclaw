import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import * as convergence from "../../commands/doctor/shared/post-core-plugin-convergence.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import {
  writePersistedInstalledPluginIndexInstallRecords,
  readPersistedInstalledPluginIndexInstallRecords,
} from "../../plugins/installed-plugin-index-records.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import * as cohort from "../../plugins/update-cohort.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { preparePostCorePluginConfig } from "./update-command-config.js";
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";

describe("post-core plugin payload degradation", () => {
  it.each([
    ["missing-owner", true, "warning", "unsafe", "unowned-plugin-payload"],
    ["missing-owner", false, "warning", "unsafe", "unowned-plugin-payload"],
    ["consent", true, "warning", "unsafe", "capability-consent-required"],
    ["consent", false, "warning", "unsafe", "capability-consent-required"],
    ["integrity", true, "warning", "unsafe", "integrity-drift"],
    ["integrity", false, "warning", "unsafe", "integrity-drift"],
    ["unclassified", true, "ok", "unsafe", "convergence-failed"],
    ["unclassified", false, "ok", "no-payload-repair", undefined],
    ["unknown-requirement", true, "warning", "unsafe", "plugin-requirement-unknown"],
    ["unknown-requirement", false, "warning", "unsafe", "plugin-requirement-unknown"],
    ["required", true, "warning", "unsafe", "required-plugin-unavailable"],
    ["required", false, "warning", "unsafe", "required-plugin-unavailable"],
    ["mixed", true, "warning", "unsafe", "unowned-plugin-payload"],
    ["repaired-advisory", true, "warning", "optional-repair-needed", undefined],
    ["optional", true, "warning", "optional-repair-needed", undefined],
    ["optional", false, "warning", "optional-repair-needed", undefined],
    ["invalid-config", true, "error", "core-critical", "invalid-config"],
    ["authority", true, undefined, undefined, undefined],
  ] as const)(
    "classifies %s with convergence errored=%s and update status=%s",
    async (failure, errored, status, kind, reason) => {
      await withOpenClawTestState({ label: `plugin-assessment-${failure}` }, async (state) => {
        await state.writeConfig({ plugins: { enabled: false } });
        const refusal = new Error("original updater authority refused");
        const installPath = state.path("fixture");
        const smokeFailure = {
          pluginId: "fixture",
          reason:
            failure === "missing-owner"
              ? ("missing-install-path" as const)
              : ("missing-extension-entry" as const),
          detail: "unavailable",
          ...(failure === "missing-owner" ? {} : { installPath }),
        };
        const convergeCohort = cohort.convergePluginReleaseCohort;
        const cohortSpy =
          failure === "integrity" || failure === "repaired-advisory"
            ? vi
                .spyOn(cohort, "convergePluginReleaseCohort")
                .mockImplementationOnce(async (options) => {
                  if (failure === "integrity") {
                    await options.onIntegrityDrift?.({
                      pluginId: "fixture",
                      spec: "fixture@1.0.0",
                      expectedIntegrity: "sha512-known",
                      actualIntegrity: "sha512-changed",
                      dryRun: false,
                    });
                  }
                  const result = await convergeCohort(options);
                  return failure === "repaired-advisory"
                    ? {
                        ...result,
                        missingPayloads: [
                          {
                            pluginId: "repaired",
                            installPath: state.path("repaired"),
                            reason: "missing-package-dir",
                          },
                        ],
                        repairedMissingPayloadIds: new Set(["repaired"]),
                        repairOutcomes: [
                          { pluginId: "repaired", status: "updated", message: "Payload restored" },
                        ],
                      }
                    : result;
                })
            : undefined;
        const spy = vi
          .spyOn(convergence, "runPostCorePluginConvergence")
          .mockImplementationOnce(async () => {
            if (failure === "authority") {
              throw refusal;
            }
            return {
              changes: [],
              warnings:
                failure === "unclassified"
                  ? []
                  : [
                      {
                        pluginId: "fixture",
                        reason: "missing payload",
                        message: "unavailable",
                        guidance: [],
                      },
                    ],
              installRecords: {},
              errored,
              smokeFailures:
                failure === "unclassified"
                  ? []
                  : [
                      smokeFailure,
                      ...(failure === "mixed"
                        ? [
                            {
                              pluginId: "another",
                              reason: "missing-install-path" as const,
                              detail: "No isolation root",
                            },
                          ]
                        : []),
                    ],
              outcomes:
                failure === "consent"
                  ? [
                      {
                        pluginId: "fixture",
                        status: "error",
                        code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
                        message: "Consent required",
                      },
                    ]
                  : [],
            };
          });
        try {
          const prepared = await preparePostCorePluginConfig({ requestedChannel: null });
          const params = {
            root: state.root,
            channel: "stable" as const,
            ...prepared,
            ...(failure === "invalid-config"
              ? { configSnapshot: { ...prepared.configSnapshot, valid: false } }
              : {}),
            ...(failure === "unknown-requirement"
              ? {}
              : {
                  pluginRequirements: {
                    fixture: failure === "required" ? ("required" as const) : ("optional" as const),
                  },
                }),
            timeoutMs: 1_000,
            json: true,
          };
          const update = updatePluginsAfterCoreUpdate(params);
          if (failure === "authority") {
            await expect(update).rejects.toBe(refusal);
          } else {
            const result = await update;
            expect(result).toMatchObject({
              status,
              assessment: { kind, ...(reason ? { reason } : {}) },
            });
            expect(result.reason).toBe(failure === "invalid-config" ? "invalid-config" : undefined);
            if (kind === "optional-repair-needed") {
              expect(result.assessment).toMatchObject({ failures: [smokeFailure] });
            }
            if (failure === "repaired-advisory") {
              expect(result.npm.outcomes).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ pluginId: "repaired", status: "error" }),
                  expect.objectContaining({ pluginId: "repaired", status: "updated" }),
                  expect.objectContaining({ pluginId: "fixture", status: "error" }),
                ]),
              );
            }
          }
        } finally {
          spy.mockRestore();
          cohortSpy?.mockRestore();
        }
      });
    },
  );
});

describe("failed cohort repair requirement assessment", () => {
  it.each(["required", "unknown", "optional"] as const)(
    "keeps an unavailable %s payload visible after the real failed repair",
    async (requirement) => {
      await withOpenClawTestState({ label: `unavailable-repair-${requirement}` }, async (state) => {
        const pluginId = "cohort-broken";
        const installPath = state.path("missing-package");
        const records: Record<string, PluginInstallRecord> = {
          [pluginId]: { source: "npm", spec: "@example/cohort-broken", installPath },
        };
        const config = {
          plugins: { entries: { [pluginId]: { enabled: true, config: { retained: "authored" } } } },
        };
        await state.writeConfig(config);
        const dataPath = await state.writeText("plugin-data.txt", "newer data survives");
        const npmConfigPath = await state.writeText("empty.npmrc", "");
        await writePersistedInstalledPluginIndexInstallRecords(records, {
          config,
          env: process.env,
        });
        let requests = 0;
        await withServer(
          (_request, response) => {
            requests += 1;
            response.writeHead(404);
            response.end("Fixture package unavailable");
          },
          async (registry) => {
            await withEnvAsync(
              {
                NPM_CONFIG_REGISTRY: registry,
                npm_config_registry: registry,
                NPM_CONFIG_CACHE: state.path("npm-cache"),
                NPM_CONFIG_USERCONFIG: npmConfigPath,
                OPENCLAW_BUNDLED_PLUGINS_DIR: state.path("empty-bundled"),
              },
              async () => {
                const result = await withPluginCache(createPluginCache(), async () =>
                  updatePluginsAfterCoreUpdate({
                    root: state.root,
                    channel: "stable",
                    ...(await preparePostCorePluginConfig({ requestedChannel: null })),
                    pluginInstallRecords: records,
                    ...(requirement === "unknown"
                      ? {}
                      : { pluginRequirements: { [pluginId]: requirement } }),
                    timeoutMs: 10_000,
                    json: true,
                  }),
                );
                expect(requests).toBeGreaterThan(0);
                expect(result.npm.outcomes).toContainEqual(
                  expect.objectContaining({
                    pluginId,
                    status: "error",
                  }),
                );
                const persisted = JSON.parse(await fs.readFile(state.configPath, "utf8"));
                expect(persisted.plugins.entries[pluginId]).toMatchObject({
                  enabled: true,
                  config: { retained: "authored" },
                });
                expect(result.reason).toBeUndefined();
                expect(readPersistedInstalledPluginIndexInstallRecords()).toEqual(records);
                expect(await fs.readFile(dataPath, "utf8")).toBe("newer data survives");
                expect(result).toMatchObject({
                  status: "warning",
                  assessment:
                    requirement === "optional"
                      ? {
                          kind: "optional-repair-needed",
                          failures: [expect.objectContaining({ pluginId, installPath })],
                        }
                      : {
                          kind: "unsafe",
                          reason:
                            requirement === "required"
                              ? "required-plugin-unavailable"
                              : "plugin-requirement-unknown",
                        },
                });
              },
            );
          },
        );
      });
    },
  );
});
