import fs from "node:fs";
import path from "node:path";
import * as fileReplacement from "@openclaw/fs-safe/atomic";
import { afterEach, expect, it, vi } from "vitest";
import * as healthState from "../config/io.health-state.js";
import type { ConfigHealthState } from "../config/io.health-state.types.js";
import { createConfigIO } from "../config/io.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import * as safeFs from "../infra/fs-safe.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

vi.mock("@openclaw/fs-safe/atomic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/atomic")>()),
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

function withHealthHome(run: (home: string) => Promise<void>) {
  return withDoctorConfigPreflightHome(async (home) => {
    try {
      await run(home);
    } finally {
      await closeOpenClawStateDatabaseAsync();
    }
  });
}

const configRaw = (port: number) =>
  JSON.stringify({ meta: { lastTouchedVersion: "2026.9.4" }, gateway: { mode: "local", port } });

async function createFixture(home: string) {
  const configPath = await writeOpenClawConfig(home, {
    meta: { lastTouchedVersion: "2026.9.4" },
    gateway: { mode: "local", port: 19091 },
  });
  const options = {
    configPath,
    env: { ...process.env, HOME: home },
    homedir: () => home,
    logger: { warn: vi.fn(), error: vi.fn() },
  };
  const io = createConfigIO(options);
  const read = () => createConfigIO({ ...options, observe: false }).readConfigFileSnapshot();
  return { configPath, options, io, read };
}

it.skipIf(process.platform === "win32")(
  "preserves custom parent permissions during promotion and retains recovery hardening",
  () =>
    withHealthHome(async (home) => {
      const directory = path.join(home, "custom-config");
      const configPath = path.join(directory, "openclaw.json");
      fs.mkdirSync(directory, { mode: 0o750 });
      fs.chmodSync(directory, 0o750);
      const raw = configRaw(19091);
      fs.writeFileSync(configPath, raw);
      const options = {
        configPath,
        env: { ...process.env, HOME: home },
        homedir: () => home,
        logger: { warn: vi.fn(), error: vi.fn() },
      };
      const io = createConfigIO(options);
      const good = await createConfigIO({ ...options, observe: false }).readConfigFileSnapshot();
      expect(await io.promoteConfigSnapshotToLastKnownGood(good)).toBe(true);
      expect(fs.readFileSync(`${configPath}.last-good`, "utf8")).toBe(raw);
      expect(fs.statSync(`${configPath}.last-good`).mode & 0o777).toBe(0o600);
      expect(fs.statSync(directory).mode & 0o777).toBe(0o750);

      fs.writeFileSync(configPath, "{ invalid json");
      const invalid = await createConfigIO({
        ...options,
        observe: false,
      }).readConfigFileSnapshot();
      expect(
        await io.recoverConfigFromLastKnownGood({ snapshot: invalid, reason: "fixture" }),
      ).toBe(true);
      expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    }),
);

it("keeps the last-known-good file when a newer observation supersedes promotion", () =>
  withHealthHome(async (home) => {
    const { configPath, options, io, read } = await createFixture(home);
    const good = await read();
    expect(await io.promoteConfigSnapshotToLastKnownGood(good)).toBe(true);
    const olderRaw = configRaw(19092);
    fs.writeFileSync(configPath, olderRaw);
    const older = await read();
    const newerRaw = configRaw(19093);
    let observedNewer = false;
    let expectedHealth: ConfigHealthState | undefined;
    const openRoot = safeFs.root;
    vi.spyOn(safeFs, "root").mockImplementation(async (...args) => {
      const directory = await openRoot(...args);
      const write = directory.write.bind(directory);
      directory.write = async (relativePath, data, writeOptions) => {
        if (!observedNewer && data === olderRaw) {
          observedNewer = true;
          fs.writeFileSync(configPath, newerRaw);
          expect(io.loadConfig().gateway?.port).toBe(19093);
          expectedHealth = healthState.readConfigHealthStateFromStore(options);
        }
        return write(relativePath, data, writeOptions);
      };
      return directory;
    });
    const promoted = await io.promoteConfigSnapshotToLastKnownGood(older);
    expect(observedNewer).toBe(true);
    expect(expectedHealth?.entries?.[configPath]?.lastKnownGood?.hash).toBe(
      hashConfigRaw(newerRaw),
    );
    expect(fs.readFileSync(`${configPath}.last-good`, "utf8")).toBe(good.raw);
    expect(fs.readFileSync(configPath, "utf8")).toBe(newerRaw);
    expect(healthState.readConfigHealthStateFromStore(options)).toEqual(expectedHealth);
    expect(promoted).toBe(false);
    await closeOpenClawStateDatabaseAsync();
    expect(healthState.readConfigHealthStateFromStore(options)).toEqual(expectedHealth);
  }));

it.each(
  (["promotion", "Doctor recovery"] as const).flatMap((operation) =>
    ["supersession", "admission retirement"].map((metadata) => ({ operation, metadata })),
  ),
)(
  "$operation preserves committed file truth and newer health after $metadata",
  ({ operation, metadata }) =>
    withHealthHome(async (home) => {
      const { configPath, options, io, read } = await createFixture(home);
      const good = await read();
      expect(await io.promoteConfigSnapshotToLastKnownGood(good)).toBe(true);
      const goodRaw = fs.readFileSync(configPath, "utf8");
      const targetRaw = operation === "promotion" ? configRaw(19092) : "{ invalid json";
      fs.writeFileSync(configPath, targetRaw);
      const target = await read();
      expect(target.valid).toBe(operation === "promotion");
      const newerRaw = configRaw(19093);
      const capture = healthState.captureConfigHealthStateStore;
      let superseded = false;
      let expectedHealth: ConfigHealthState | undefined;
      vi.spyOn(healthState, "captureConfigHealthStateStore").mockImplementation((...args) => {
        const store = capture(...args);
        return {
          ...store,
          async updateAfterFileCommit(...updateArgs) {
            if (
              !superseded &&
              args[1] === configPath &&
              Object.hasOwn(updateArgs[0], "lastPromotedGood")
            ) {
              superseded = true;
              const committedPath =
                operation === "promotion" ? `${configPath}.last-good` : configPath;
              expect(fs.readFileSync(committedPath, "utf8")).toBe(
                operation === "promotion" ? targetRaw : goodRaw,
              );
              fs.writeFileSync(configPath, newerRaw);
              expect(io.loadConfig().gateway?.port).toBe(19093);
              expectedHealth = healthState.readConfigHealthStateFromStore(options);
              expect(expectedHealth.entries?.[configPath]?.lastKnownGood?.hash).toBe(
                hashConfigRaw(newerRaw),
              );
              if (metadata === "admission retirement") {
                await closeOpenClawStateDatabaseAsync();
              }
            }
            await store.updateAfterFileCommit(...updateArgs);
          },
        };
      });
      if (operation === "promotion") {
        expect(await io.promoteConfigSnapshotToLastKnownGood(target)).toBe(true);
        expect(fs.readFileSync(`${configPath}.last-good`, "utf8")).toBe(targetRaw);
      } else {
        const result = await withEnvAsync(
          {
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
            OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
          },
          () =>
            runDoctorConfigPreflight({
              migrateState: false,
              migrateLegacyConfig: false,
              repairPrefixedConfig: true,
              invalidConfigNote: false,
              observe: false,
            }),
        );
        expect(result.snapshot.valid).toBe(true);
        expect(result.snapshot.raw).toBe(newerRaw);
        expect(result.snapshot.config.gateway?.port).toBe(19093);
      }
      expect(superseded).toBe(true);
      expect(expectedHealth).toBeDefined();
      expect(fs.readFileSync(configPath, "utf8")).toBe(newerRaw);
      expect(healthState.readConfigHealthStateFromStore(options)).toEqual(expectedHealth);
      await closeOpenClawStateDatabaseAsync();
      expect(healthState.readConfigHealthStateFromStore(options)).toEqual(expectedHealth);
    }),
);

it("rejects last-known-good recovery after its captured database admission closes", () =>
  withHealthHome(async (home) => {
    const { configPath, io, read } = await createFixture(home);
    const good = await read();
    expect(await io.promoteConfigSnapshotToLastKnownGood(good)).toBe(true);
    const rejectedRaw = "{ invalid json";
    fs.writeFileSync(configPath, rejectedRaw);
    const rejected = await read();
    const replace = fileReplacement.replaceFileAtomic;
    let closed = false;
    vi.spyOn(fileReplacement, "replaceFileAtomic").mockImplementation(async (params) => {
      if (params.filePath === configPath && !closed) {
        closed = true;
        await closeOpenClawStateDatabaseAsync();
      }
      return replace(params);
    });
    await expect(
      io.recoverConfigFromLastKnownGood({
        snapshot: rejected,
        reason: "fixture-invalid-config",
      }),
    ).rejects.toThrow("read admission");
    expect(closed).toBe(true);
    expect(fs.readFileSync(configPath, "utf8")).toBe(rejectedRaw);
  }));
