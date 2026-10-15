import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { runWriteConfigHealth } from "../flows/doctor-health-contribution-runners.config.js";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contribution-types.js";
import { captureUpdateDoctorConfigWrites } from "../infra/update-doctor-result.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { useDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { finalizeDoctorConfigFlow } from "./doctor/finalize-config-flow.js";
import { prepareDoctorConfigReferenceSource } from "./doctor/shared/config-flow-steps.js";

const withDoctorConfigPreflightHome = useDoctorConfigPreflightHome();

async function plan(configPath: string): Promise<DoctorHealthFlowContext> {
  const snapshot = await readConfigFileSnapshot();
  const cfg = structuredClone(snapshot.sourceConfig);
  const finalized = await finalizeDoctorConfigFlow({
    cfg,
    candidate: cfg,
    snapshot,
    pendingChanges: false,
    shouldRepair: true,
    fixHints: [],
    confirm: async () => true,
    note: () => {},
  });
  return {
    runtime: { log: () => {}, error: () => {}, exit: () => {} },
    options: {},
    prompter: {} as DoctorHealthFlowContext["prompter"],
    configResult: {
      ...finalized,
      referenceSource: prepareDoctorConfigReferenceSource(snapshot),
      skipWizardMetadataForIncludeWrite: true,
    },
    cfg,
    cfgForPersistence: structuredClone(cfg),
    sourceConfigValid: true,
    configPath,
    env: {},
  };
}
async function files(directory: string): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      (await fs.readdir(directory)).toSorted().map(async (name) => {
        const target = path.join(directory, name);
        const stat = await fs.stat(target);
        return [name, stat.isFile() ? (await fs.readFile(target)).toString("hex") : "<directory>"];
      }),
    ),
  );
}
describe("Doctor receipt owner with real config files", () => {
  afterEach(() => closeOpenClawStateDatabaseForTest());
  it.each([
    { include: false, authority: false },
    { include: true, authority: false },
    { include: true, authority: true },
  ])(
    "chains commits and refuses raw drift (include=$include, authority=$authority)",
    async ({ include, authority }) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local" },
          agents: {
            entries: { main: include ? { $include: "./agent.json5" } : { name: "initial" } },
          },
        });
        const fragmentPath = path.join(path.dirname(configPath), "agent.json5");
        if (include) {
          await fs.writeFile(fragmentPath, '{name:"initial"}\n');
        }
        const rootBefore = await fs.readFile(configPath, "utf8");
        const ctx = await plan(configPath);
        const write = () =>
          captureUpdateDoctorConfigWrites(
            configPath,
            () => runWriteConfigHealth(ctx, { runPostWriteRepairs: false }),
            authority
              ? { inputHash: hashConfigRaw(rootBefore), assertCurrent: () => {} }
              : undefined,
          );
        for (const name of ["first", "second"]) {
          ctx.cfg = {
            ...ctx.cfg,
            agents: {
              ...ctx.cfg.agents,
              entries: {
                ...ctx.cfg.agents?.entries,
                main: { ...ctx.cfg.agents?.entries?.main, name },
              },
            },
          };
          expect(await write()).toBe(true);
          const snapshot = await readConfigFileSnapshot();
          expect(ctx.configResult.confirmedConfigSource).toEqual({
            path: configPath,
            hash: snapshot.hash,
          });
          expect(snapshot.sourceConfig.agents?.entries?.main?.name).toBe(name);
        }
        if (include) {
          expect(await fs.readFile(configPath, "utf8")).toBe(rootBefore);
        }
        const target = include ? fragmentPath : configPath;
        const before = await readConfigFileSnapshot();
        await fs.appendFile(target, "\n// operator-only raw drift\n");
        const drifted = await readConfigFileSnapshot();
        expect(drifted.sourceConfig).toEqual(before.sourceConfig);
        expect(drifted.hash).not.toBe(before.hash);
        const baseline = ctx.cfgForPersistence;
        const receipt = ctx.configResult.confirmedConfigSource;
        const retained = await files(path.dirname(configPath));
        ctx.cfg = {
          ...ctx.cfg,
          agents: {
            ...ctx.cfg.agents,
            entries: {
              ...ctx.cfg.agents?.entries,
              main: { ...ctx.cfg.agents?.entries?.main, name: "third" },
            },
          },
        };
        expect(await write()).toBe(false);
        expect(ctx.configWriteRefusal).toBe("config-conflict");
        expect(ctx.cfgForPersistence).toBe(baseline);
        expect(ctx.configResult.confirmedConfigSource).toBe(receipt);
        expect(await files(path.dirname(configPath))).toEqual(retained);
      });
    },
  );
  it("creates a missing root, advances its receipt, and refuses an equal-byte active path", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const ctx = await plan(configPath);
      expect(ctx.configResult.confirmedConfigSource?.hash).toBe(hashConfigRaw(null));
      ctx.cfg = { gateway: { mode: "local" } };
      expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
      const first = await fs.readFile(configPath, "utf8");
      ctx.cfg = { gateway: { mode: "local", port: 19090 } };
      expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
      expect(await fs.readFile(configPath + ".bak", "utf8")).toBe(first);
      const alternate = path.join(path.dirname(configPath), "alternate.json");
      await fs.copyFile(configPath, alternate);
      const { withEnvAsync } = await import("../test-utils/env.js");
      const baseline = ctx.cfgForPersistence;
      const receipt = ctx.configResult.confirmedConfigSource;
      const retained = await files(path.dirname(configPath));
      ctx.cfg = { gateway: { mode: "local", port: 19091 } };
      await withEnvAsync({ OPENCLAW_CONFIG_PATH: alternate }, async () => {
        expect(await runWriteConfigHealth(ctx)).toBe(false);
      });
      expect(ctx.configWriteRefusal).toBe("config-conflict");
      expect(ctx.cfgForPersistence).toBe(baseline);
      expect(ctx.configResult.confirmedConfigSource).toBe(receipt);
      expect(await files(path.dirname(configPath))).toEqual(retained);
    });
  });
});
