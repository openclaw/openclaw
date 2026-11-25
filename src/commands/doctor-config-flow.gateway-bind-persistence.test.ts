import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createConfigIO,
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
} from "../config/config.js";
import { withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import {
  planLegacyConfigForUpdateChannel,
  repairLegacyConfigForUpdateChannel,
} from "./doctor/legacy-config-repair.js";

const read = (file: string) => fs.readFile(file, "utf8");
const readJson = async (file: string) => JSON.parse(await read(file));
const migratedOtel = { enabled: false, endpoint: "http://collector.test:4317" };
afterEach(closeOpenClawStateDatabaseForTest);

it.each(["include", "invalid", "doctor"] as const)(
  "preserves authored plugin scope during %s config repair",
  (scenario) =>
    withDoctorConfigPreflightHome(async (home) => {
      const diagnostics = {
        otel: { enabled: true, endpoint: "http://collector.test:4317", protocol: "grpc" },
      };
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local", ...(scenario === "invalid" ? { port: "invalid" } : {}) },
        diagnostics: scenario === "include" ? { $include: "diagnostics.json" } : diagnostics,
        plugins: { entries: { canvas: { enabled: true, config: { host: { enabled: false } } } } },
        ...(scenario === "doctor" ? { agents: { defaults: { models: { bare: {} } } } } : {}),
      });
      const includePath = path.join(path.dirname(configPath), "diagnostics.json");
      if (scenario === "include") {
        await fs.writeFile(includePath, JSON.stringify(diagnostics));
      }
      const before = await read(configPath);
      const prepared = await readConfigFileSnapshotForWrite();
      expect(prepared.snapshot.sourceConfig.commands).toBeUndefined();
      let result: Awaited<ReturnType<typeof repairLegacyConfigForUpdateChannel>>;
      if (scenario === "doctor") {
        await using ctx = await prepareDoctorContext(configPath);
        // Deferred model advice leaves the actual migration to Doctor's config flow.
        expect(await read(configPath)).toBe(before);
        expect(ctx.configResult.shouldWriteConfig).toBe(true);
        await runInitialConfigWriteHealth(ctx);
        result = {
          snapshot: await readConfigFileSnapshot(),
          repaired: ctx.configResultWriteCommitted === true,
        };
      } else {
        result = await repairLegacyConfigForUpdateChannel({
          configSnapshot: prepared.snapshot,
          configWriteOptions: prepared.writeOptions,
          jsonMode: true,
        });
      }
      if (scenario === "invalid") {
        expect(result.repaired).toBe(false);
        expect(await read(configPath)).toBe(before);
        return;
      }
      expect(result.repaired).toBe(true);
      const saved = await readJson(configPath);
      expect(Object.keys(saved.plugins.entries)).toEqual(["canvas"]);
      if (scenario === "doctor") {
        expect(saved.agents.defaults.models).toStrictEqual({ bare: {} });
      }
      expect(saved).not.toHaveProperty("commands");
      expect(result.snapshot.config.diagnostics?.otel).toEqual(migratedOtel);
      if (scenario === "include") {
        expect(saved.diagnostics).toEqual({ $include: "diagnostics.json" });
        expect(await readJson(includePath)).toEqual({ otel: migratedOtel });
      }
    }),
);

it.each(["unchanged", "root edit", "include edit", "different profile"] as const)(
  "persists a prepared legacy plan only for its original source: %s",
  (scenario) =>
    withTempHome((home) =>
      withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const configPath = await writeOpenClawConfig(home, {
          gateway: { $include: "gateway.json" },
        });
        const includePath = path.join(path.dirname(configPath), "gateway.json");
        await fs.writeFile(includePath, '{"mode":"local","bind":"localhost"}\n');
        const { snapshot, writeOptions } = await createConfigIO({
          observe: false,
        }).readConfigFileSnapshotForWrite();
        const plan = planLegacyConfigForUpdateChannel(snapshot, writeOptions);
        expect(plan).toBeDefined();
        const original = await read(configPath);
        const originalInclude = await read(includePath);
        const persist = () =>
          repairLegacyConfigForUpdateChannel({ configSnapshot: snapshot, plan, jsonMode: true });
        // Planning is read-only; original authored bytes still exist at the seal boundary.
        expect(snapshot.raw).toBe(original);
        expect(await read(includePath)).toBe(originalInclude);
        if (scenario === "unchanged") {
          const result = await persist();
          expect(result.repaired).toBe(true);
          expect(result.snapshot.config.gateway?.bind).toBe("loopback");
          expect(await read(configPath)).toBe(original);
          expect((await readJson(includePath)).bind).toBe("loopback");
        } else if (scenario === "different profile") {
          const otherPath = path.join(path.dirname(configPath), "other.json");
          await fs.writeFile(otherPath, original);
          await withEnvAsync({ OPENCLAW_CONFIG_PATH: otherPath }, async () => {
            await expect(persist()).rejects.toThrow(/config path changed/);
          });
          expect(await read(otherPath)).toBe(original);
          expect(await read(configPath)).toBe(original);
          expect(await read(includePath)).toBe(originalInclude);
        } else {
          const editedPath = scenario === "root edit" ? configPath : includePath;
          await fs.appendFile(editedPath, "\n");
          await expect(persist()).rejects.toThrow(/changed since last load/);
          expect(await read(editedPath)).toBe(
            (scenario === "root edit" ? original : originalInclude) + "\n",
          );
        }
      }),
    ),
);
