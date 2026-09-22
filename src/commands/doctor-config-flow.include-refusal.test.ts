// Regression: doctor --fix whose candidate mixes an include-owned repair with a
// root-owned repair must not print "Doctor changes" and then crash on the root
// writer's include guard. The writer refuses, Doctor records the refusal, and
// every file stays byte-identical with the included file named for manual repair.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelVisibilityPolicy } from "../agents/model-visibility-policy.js";
import { readConfigFileSnapshot, transformConfigFile } from "../config/config.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { ConfigMutationConflictError } from "../config/mutation-conflict.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { runWriteConfigHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { captureUpdateDoctorConfigWrites } from "../infra/update-doctor-result.js";
import { UpdateRequesterRevokedError } from "../infra/update-requester-authority.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

const noteMock = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: noteMock,
}));

describe("doctor --fix include write ownership", () => {
  afterEach(() => {
    noteMock.mockClear();
    closeOpenClawStateDatabaseForTest();
  });

  it.each([
    { shape: "nested-defaults", authority: false },
    { shape: "nested-defaults", authority: true },
    { shape: "included-roster", authority: false },
    { shape: "included-roster", authority: true },
  ] as const)(
    "migrates a published $shape config without flattening includes (authority=$authority)",
    async ({ shape, authority }) => {
      await withDoctorConfigPreflightHome(async (home) => {
        await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
          const configPath = await writeOpenClawConfig(home, {
            agents: { $include: "./agents.json5" },
            gateway: { mode: "local" },
            plugins: { enabled: false },
          });
          const dir = path.dirname(configPath);
          const defaults = { models: { "openai/gpt-5.5": { alias: "Config Lab" } } };
          const agents =
            shape === "nested-defaults"
              ? { defaults: { $include: "./defaults.json5" }, entries: { ops: {} } }
              : {
                  defaults,
                  list: [
                    {
                      id: "ops",
                      default: true,
                      memorySearch: { enabled: false, query: { maxResults: 7 } },
                    },
                  ],
                };
          const agentsPath = path.join(dir, "agents.json5");
          const agentsRaw = JSON.stringify(agents);
          await fs.writeFile(agentsPath, agentsRaw);
          const defaultsPath = path.join(dir, "defaults.json5");
          if (shape === "nested-defaults") {
            await fs.writeFile(defaultsPath, JSON.stringify(defaults));
          }
          const rootRaw = await fs.readFile(configPath, "utf8");
          const ctx = await prepareDoctorContext(configPath);
          await captureUpdateDoctorConfigWrites(
            configPath,
            () => runWriteConfigHealth(ctx, { runPostWriteRepairs: false }),
            authority ? { inputHash: hashConfigRaw(rootRaw), assertCurrent: () => {} } : undefined,
          );

          expect(ctx.configWriteRefusal).toBeUndefined();
          expect(ctx.configResultWriteCommitted).toBe(true);
          await expect(fs.readFile(configPath, "utf8")).resolves.toBe(rootRaw);
          const savedAgents = JSON.parse(await fs.readFile(agentsPath, "utf8"));
          const savedDefaults =
            shape === "nested-defaults"
              ? JSON.parse(await fs.readFile(defaultsPath, "utf8"))
              : savedAgents.defaults;
          expect(savedDefaults.models).toEqual(defaults.models);
          expect(savedDefaults.modelPolicy).toEqual({ allow: ["openai/gpt-5.5"] });
          if (shape === "nested-defaults") {
            await expect(fs.readFile(agentsPath, "utf8")).resolves.toBe(agentsRaw);
          } else {
            expect(savedAgents).not.toHaveProperty("list");
            expect(savedAgents.entries.ops.memory).toEqual({
              search: { enabled: false, query: { maxResults: 7 } },
            });
          }
          expect((await prepareDoctorContext(configPath)).configResult.shouldWriteConfig).toBe(
            false,
          );

          await transformConfigFile({
            transform: (current) => {
              const nextConfig = structuredClone(current);
              const agentConfig = nextConfig.agents;
              if (!agentConfig?.defaults) {
                throw new Error("expected migrated agent defaults");
              }
              if (shape === "included-roster") {
                delete agentConfig.defaults;
              } else {
                delete agentConfig.defaults.modelPolicy;
                delete agentConfig.defaults.models;
              }
              return { nextConfig };
            },
          });
          await transformConfigFile({
            transform: (current) => ({
              nextConfig: {
                ...current,
                agents: {
                  ...current.agents,
                  defaults: {
                    ...current.agents?.defaults,
                    models: { "openai/gpt-5.5": { alias: "New metadata" } },
                  },
                },
              },
            }),
          });
          const reloaded = await readConfigFileSnapshot();
          expect(reloaded.valid).toBe(true);
          expect(reloaded.config.agents?.defaults?.modelPolicy).toEqual({});
          expect(reloaded.legacyIssues).toEqual([]);
          expect(
            createModelVisibilityPolicy({
              cfg: reloaded.config,
              catalog: [],
              defaultProvider: "openai",
              agentId: "ops",
            }).allowAny,
          ).toBe(true);
          await expect(
            transformConfigFile({
              transform: (current) => ({
                nextConfig: {
                  ...current,
                  meta: { migrations: { modelPolicyAllowlist: true } },
                  agents: {
                    ...current.agents,
                    defaults: {
                      ...current.agents?.defaults,
                      models: { "openai/gpt-5.5": { alias: "Explicit marker edit" } },
                    },
                  },
                },
              }),
              writeOptions: {
                explicitSetPaths: [["meta", "migrations", "modelPolicyAllowlist"]],
              },
            }),
          ).rejects.toThrow("flatten $include-owned config");
          expect((await readConfigFileSnapshot()).sourceConfig).toEqual(reloaded.sourceConfig);
          await expect(fs.readFile(configPath, "utf8")).resolves.toBe(rootRaw);
        });
      });
    },
  );

  it.each([
    { authority: false, refusal: undefined },
    { authority: true, refusal: undefined },
    { authority: true, refusal: "requester-revoked" },
    { authority: true, refusal: "config-input-changed" },
    { authority: true, refusal: "include-input-changed" },
  ] as const)(
    "writes a nested agent repair to its fragment and preserves both ancestor files (authority=$authority, refusal=$refusal)",
    async ({ authority, refusal }) => {
      await withDoctorConfigPreflightHome(async (home) => {
        await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
          const configPath = await writeOpenClawConfig(home, {
            agents: { entries: { main: { $include: "./config/main-parent.json5" } } },
            gateway: { mode: "local" },
          });
          const fragmentDir = path.join(path.dirname(configPath), "config");
          await fs.mkdir(fragmentDir);
          const parentPath = path.join(fragmentDir, "main-parent.json5");
          const parentRaw = '{ /* keep this delegation */ $include: "./main.json5" }\n';
          await fs.writeFile(parentPath, parentRaw);
          const fragmentPath = path.join(fragmentDir, "main.json5");
          const fragmentRaw = JSON.stringify({ sandbox: { perSession: true } });
          await fs.writeFile(fragmentPath, fragmentRaw);
          const rootRaw = await fs.readFile(configPath, "utf-8");

          const ctx = await prepareDoctorContext(configPath);
          expect(ctx.configResult.shouldWriteConfig).toBe(true);
          expect(ctx.configResult.skipWizardMetadataForIncludeWrite).toBe(true);
          const retainedFragmentRaw =
            refusal === "include-input-changed"
              ? JSON.stringify({ sandbox: { perSession: true }, name: "Operator edit" })
              : fragmentRaw;
          if (refusal === "include-input-changed") {
            await fs.writeFile(fragmentPath, retainedFragmentRaw);
          }
          const writing = captureUpdateDoctorConfigWrites(
            configPath,
            () => runWriteConfigHealth(ctx, { runPostWriteRepairs: false }),
            authority
              ? {
                  inputHash: hashConfigRaw(refusal === "config-input-changed" ? "{}" : rootRaw),
                  assertCurrent: () => {
                    if (refusal === "requester-revoked") {
                      throw new UpdateRequesterRevokedError();
                    }
                  },
                }
              : undefined,
          );
          if (refusal === "requester-revoked") {
            await expect(writing).rejects.toBeInstanceOf(UpdateRequesterRevokedError);
          } else if (refusal === "config-input-changed" || refusal === "include-input-changed") {
            await expect(writing).rejects.toBeInstanceOf(ConfigMutationConflictError);
          } else {
            await writing;
          }
          if (refusal) {
            expect(ctx.configResultWriteCommitted).not.toBe(true);
            await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(rootRaw);
            await expect(fs.readFile(parentPath, "utf-8")).resolves.toBe(parentRaw);
            await expect(fs.readFile(fragmentPath, "utf-8")).resolves.toBe(retainedFragmentRaw);
            expect((await fs.readdir(fragmentDir)).toSorted()).toEqual([
              "main-parent.json5",
              "main.json5",
            ]);
            return;
          }

          expect(ctx.configWriteRefusal).toBeUndefined();
          expect(ctx.configResultWriteCommitted).toBe(true);
          expect(JSON.parse(await fs.readFile(fragmentPath, "utf-8"))).toEqual({
            sandbox: { scope: "session" },
          });
          await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(rootRaw);
          await expect(fs.readFile(parentPath, "utf-8")).resolves.toBe(parentRaw);
          if (authority) {
            expect(ctx.updateWarnings).toContain(
              "Doctor include-owned keys agents: promotion unavailable for include-owned configuration.",
            );
          }
        });
      });
    },
  );

  it("records the refusal and leaves the root and the included file untouched", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const configPath = await writeOpenClawConfig(home, {
          agents: { list: [{ id: "ops" }] },
          browser: { $include: "./browser.json" },
          gateway: { mode: "local" },
        });
        const includePath = path.join(path.dirname(configPath), "browser.json");
        const includeRaw = JSON.stringify({ enabled: true, actionTimeoutMs: 5000 });
        await fs.writeFile(includePath, includeRaw);
        const rootRaw = await fs.readFile(configPath, "utf-8");

        const ctx = await prepareDoctorContext(configPath);
        // The legacy roster is a root repair; the retired knob is an include repair.
        expect(ctx.configResult.shouldWriteConfig).toBe(true);
        expect(ctx.configResult.persistCanonicalAgentRoster).toBe(true);
        expect(ctx.cfg.browser).toEqual({ enabled: true });
        const repairPanels = () =>
          noteMock.mock.calls
            .filter(([, title]) => title === "Doctor changes")
            .map(([message]) => message)
            .join("\n");
        expect(repairPanels()).not.toContain("retired runtime tuning knobs");
        expect(repairPanels()).not.toContain("canonical agent roster");

        await expect(runWriteConfigHealth(ctx)).resolves.toBeUndefined();

        // Neither queued repair reached disk, so neither is reported as done.
        expect(ctx.configWriteRefusal).toBe("include-ownership");
        expect(ctx.configResultWriteCommitted).not.toBe(true);
        expect(repairPanels()).not.toContain("retired runtime tuning knobs");
        expect(repairPanels()).not.toContain("canonical agent roster");
        const warning = noteMock.mock.calls.find(
          ([message, title]) =>
            title === "Doctor warnings" && message.includes("No config changes were written"),
        );
        expect(warning?.[0]).toContain("$include-owned config at browser");
        expect(warning?.[0]).toContain("the included file ./browser.json");
        await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(rootRaw);
        await expect(fs.readFile(includePath, "utf-8")).resolves.toBe(includeRaw);
      });
    });
  });
});
