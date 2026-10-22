import fs from "node:fs";
import path from "node:path";
import * as fileReplacement from "@openclaw/fs-safe/atomic";
import { afterEach, expect, it, vi } from "vitest";
import * as healthState from "../config/io.health-state.js";
import type { ConfigHealthState } from "../config/io.health-state.types.js";
import { createConfigIO } from "../config/io.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { ConfigMutationConflictError } from "../config/mutation-conflict.js";
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

const config = (port: number) => ({
  meta: { lastTouchedVersion: "2026.9.4" },
  gateway: { mode: "local", port },
});
const configRaw = (port: number) => JSON.stringify(config(port));
const olderRaw = configRaw(19092);
const newerRaw = configRaw(19093);

function configIO(home: string, configPath: string) {
  const options = {
    configPath,
    env: { ...process.env, HOME: home },
    homedir: () => home,
    logger: { warn: vi.fn(), error: vi.fn() },
  };
  const io = createConfigIO(options);
  const read = () => createConfigIO({ ...options, observe: false }).readConfigFileSnapshot();
  const raw = (suffix = "") => fs.readFileSync(`${configPath}${suffix}`, "utf8");
  const replace = (value: string) => {
    fs.writeFileSync(configPath, value);
    return read();
  };
  const health = () => healthState.readConfigHealthStateFromStore(options);
  const observe = (value: string) => {
    fs.writeFileSync(configPath, value);
    expect(io.loadConfig().gateway?.port).toBe(19093);
    return health();
  };
  const assertDurableHealth = async (expected: ConfigHealthState | undefined) => {
    expect(raw()).toBe(newerRaw);
    expect(expected?.entries?.[configPath]?.lastKnownGood?.hash).toBe(hashConfigRaw(newerRaw));
    expect(health()).toEqual(expected);
    await closeOpenClawStateDatabaseAsync();
    expect(health()).toEqual(expected);
  };
  return { configPath, io, read, raw, replace, observe, assertDurableHealth };
}

type Fixture = ReturnType<typeof configIO> & { goodRaw: string | null; directory: string };
function withFixture(run: (f: Fixture) => Promise<void>, custom = false) {
  return withDoctorConfigPreflightHome(async (home) => {
    try {
      const directory = path.join(home, "custom-config");
      const file = custom
        ? path.join(directory, "openclaw.json")
        : await writeOpenClawConfig(home, config(19091));
      if (custom) {
        fs.mkdirSync(directory, { mode: 0o750 });
        fs.chmodSync(directory, 0o750);
        fs.writeFileSync(file, configRaw(19091));
      }
      const f = configIO(home, file);
      const good = await f.read();
      expect(await f.io.promoteConfigSnapshotToLastKnownGood(good)).toBe(true);
      await run({ ...f, goodRaw: custom ? configRaw(19091) : good.raw, directory });
    } finally {
      await closeOpenClawStateDatabaseAsync();
    }
  });
}

it.skipIf(process.platform === "win32")(
  "preserves custom parent permissions during promotion and retains recovery hardening",
  () =>
    withFixture(async ({ configPath, directory, io, replace, raw, goodRaw }) => {
      expect(raw(".last-good")).toBe(goodRaw);
      expect(fs.statSync(`${configPath}.last-good`).mode & 0o777).toBe(0o600);
      expect(fs.statSync(directory).mode & 0o777).toBe(0o750);

      const invalid = await replace("{ invalid json");
      expect(
        await io.recoverConfigFromLastKnownGood({ snapshot: invalid, reason: "fixture" }),
      ).toBe(true);
      expect(raw()).toBe(goodRaw);
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    }, true),
);

it("refuses promotion when the captured config source changes", () =>
  withFixture(async ({ io, raw, replace, goodRaw, observe, assertDurableHealth }) => {
    const older = await replace(olderRaw);
    let observedNewer = false;
    let expectedHealth: ConfigHealthState | undefined;
    const openRoot = safeFs.root;
    vi.spyOn(safeFs, "root").mockImplementation(async (...args) => {
      const directory = await openRoot(...args);
      const write = directory.write.bind(directory);
      directory.write = async (relativePath, data, writeOptions) => {
        if (!observedNewer && data === olderRaw) {
          observedNewer = true;
          expectedHealth = observe(newerRaw);
        }
        return write(relativePath, data, writeOptions);
      };
      return directory;
    });
    await expect(io.promoteConfigSnapshotToLastKnownGood(older)).rejects.toBeInstanceOf(
      ConfigMutationConflictError,
    );
    expect(observedNewer).toBe(true);
    expect(raw(".last-good")).toBe(goodRaw);
    await assertDurableHealth(expectedHealth);
  }));

it.each(
  (["promotion", "Doctor recovery"] as const).flatMap((operation) =>
    ["supersession", "admission retirement"].map((metadata) => ({ operation, metadata })),
  ),
)(
  "$operation preserves committed file truth and newer health after $metadata",
  ({ operation, metadata }) =>
    withFixture(async ({ configPath, io, raw, replace, goodRaw, observe, assertDurableHealth }) => {
      const targetRaw = operation === "promotion" ? olderRaw : "{ invalid json";
      const target = await replace(targetRaw);
      expect(target.valid).toBe(operation === "promotion");
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
              expectedHealth = observe(newerRaw);
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
        expect(raw(".last-good")).toBe(targetRaw);
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
        expect(result.snapshot).toMatchObject({ valid: true, raw: newerRaw });
        expect(result.snapshot.config.gateway?.port).toBe(19093);
      }
      expect(superseded).toBe(true);
      expect(expectedHealth).toBeDefined();
      await assertDurableHealth(expectedHealth);
    }),
);

it("rejects last-known-good recovery after its captured database admission closes", () =>
  withFixture(async ({ configPath, io, replace, raw }) => {
    const rejectedRaw = "{ invalid json";
    const rejected = await replace(rejectedRaw);
    const replaceAtomic = fileReplacement.replaceFileAtomic;
    let closed = false;
    vi.spyOn(fileReplacement, "replaceFileAtomic").mockImplementation(async (params) => {
      if (params.filePath === configPath && !closed) {
        closed = true;
        await closeOpenClawStateDatabaseAsync();
      }
      return replaceAtomic(params);
    });
    await expect(
      io.recoverConfigFromLastKnownGood({
        snapshot: rejected,
        reason: "fixture-invalid-config",
      }),
    ).rejects.toThrow("read admission");
    expect(closed).toBe(true);
    expect(raw()).toBe(rejectedRaw);
  }));
