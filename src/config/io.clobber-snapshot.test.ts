// Covers config IO clobber snapshot handling during writes and prefix recovery lock refusal.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  persistBoundedClobberedConfigSnapshot,
  persistBoundedClobberedConfigSnapshotSync,
} from "./io.clobber-snapshot.js";
import { createConfigIO } from "./io.factory.js";
import { PREFIX_RECOVERY_PRESERVATION_REFUSED } from "./io.recovery.js";

const CONFIG_CLOBBER_SNAPSHOT_LIMIT = 32;

describe("config clobber snapshots", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-config-clobber-"));
  });

  afterAll(async () => {
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function withCase<T>(fn: (configPath: string) => Promise<T>): Promise<T> {
    const home = path.join(fixtureRoot, `case-${caseId++}`);
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, "{}\n", "utf-8");
    return await fn(configPath);
  }

  async function listClobberFiles(configPath: string): Promise<string[]> {
    const entries = await fsp.readdir(path.dirname(configPath));
    const prefix = `${path.basename(configPath)}.clobbered.`;
    return entries.filter((entry) => entry.startsWith(prefix));
  }

  async function readClobberFileContents(configPath: string): Promise<string[]> {
    const dir = path.dirname(configPath);
    const clobberFiles = await listClobberFiles(configPath);
    return await Promise.all(
      clobberFiles.map((entry) => fsp.readFile(path.join(dir, entry), "utf-8")),
    );
  }

  async function findClobberFileByContent(
    configPath: string,
    expectedContent: string,
  ): Promise<string> {
    const dir = path.dirname(configPath);
    for (const entry of await listClobberFiles(configPath)) {
      const candidatePath = path.join(dir, entry);
      if ((await fsp.readFile(candidatePath, "utf-8")) === expectedContent) {
        return candidatePath;
      }
    }
    throw new Error(`Missing clobber snapshot with content ${expectedContent}`);
  }

  async function touchClobberFilesByContentOrder(configPath: string): Promise<void> {
    const dir = path.dirname(configPath);
    const filesWithContents = await Promise.all(
      (await listClobberFiles(configPath)).map(async (entry) => ({
        entry,
        content: await fsp.readFile(path.join(dir, entry), "utf-8"),
      })),
    );
    for (const file of filesWithContents) {
      const match = /^polluted-(\d+)\n$/.exec(file.content);
      if (!match) {
        continue;
      }
      const touchedAt = new Date(
        `2026-05-03T00:00:${expectDefined(match[1], "match[1] test invariant").padStart(2, "0")}.000Z`,
      );
      await fsp.utimes(path.join(dir, file.entry), touchedAt, touchedAt);
    }
  }

  function touchClobberFilesByContentOrderSync(configPath: string): void {
    const dir = path.dirname(configPath);
    const prefix = `${path.basename(configPath)}.clobbered.`;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.startsWith(prefix)) {
        continue;
      }
      const targetPath = path.join(dir, entry);
      const match = /^polluted-(\d+)\n$/.exec(fs.readFileSync(targetPath, "utf-8"));
      if (!match) {
        continue;
      }
      const touchedAt = new Date(
        `2026-05-03T00:00:${expectDefined(match[1], "match[1] test invariant").padStart(2, "0")}.000Z`,
      );
      fs.utimesSync(targetPath, touchedAt, touchedAt);
    }
  }

  it("keeps concurrent async snapshots under the per-path cap by rotating oldest files", async () => {
    await withCase(async (configPath) => {
      const warn = vi.fn();
      const observedAt = "2026-05-03T00:00:00.000Z";

      const snapshotPaths = await Promise.all(
        Array.from({ length: CONFIG_CLOBBER_SNAPSHOT_LIMIT + 24 }, (_, index) =>
          persistBoundedClobberedConfigSnapshot({
            deps: { fs, logger: { warn } },
            configPath,
            raw: `polluted-${index}\n`,
            observedAt,
          }),
        ),
      );

      expect(snapshotPaths).not.toContain(null);
      const clobberFiles = await listClobberFiles(configPath);
      expect(clobberFiles).toHaveLength(CONFIG_CLOBBER_SNAPSHOT_LIMIT);
      const capWarnings = warn.mock.calls.filter(
        ([message]) =>
          typeof message === "string" && message.includes("Config clobber snapshot cap reached"),
      );
      expect(capWarnings).toHaveLength(1);
    });
  });

  it("rotates async snapshots so the latest clobbered config is preserved", async () => {
    await withCase(async (configPath) => {
      const warn = vi.fn();

      for (let index = 0; index < CONFIG_CLOBBER_SNAPSHOT_LIMIT + 3; index++) {
        await persistBoundedClobberedConfigSnapshot({
          deps: { fs, logger: { warn } },
          configPath,
          raw: `polluted-${index}\n`,
          observedAt: `2026-05-03T00:00:${String(index).padStart(2, "0")}.000Z`,
        });
      }

      const clobberFiles = await listClobberFiles(configPath);
      expect(clobberFiles).toHaveLength(CONFIG_CLOBBER_SNAPSHOT_LIMIT);
      const contents = await readClobberFileContents(configPath);
      expect(contents).not.toContain("polluted-0\n");
      expect(contents).not.toContain("polluted-1\n");
      expect(contents).not.toContain("polluted-2\n");
      expect(contents).toContain(`polluted-${CONFIG_CLOBBER_SNAPSHOT_LIMIT + 2}\n`);
      const capWarnings = warn.mock.calls.filter(
        ([message]) =>
          typeof message === "string" && message.includes("Config clobber snapshot cap reached"),
      );
      expect(capWarnings).toHaveLength(1);
    });
  });

  it("rotates async snapshots by artifact timestamp rather than mutable mtime", async () => {
    await withCase(async (configPath) => {
      const warn = vi.fn();

      for (let index = 0; index < CONFIG_CLOBBER_SNAPSHOT_LIMIT; index++) {
        await persistBoundedClobberedConfigSnapshot({
          deps: { fs, logger: { warn } },
          configPath,
          raw: `polluted-${index}\n`,
          observedAt: `2026-05-03T00:00:${String(index).padStart(2, "0")}.000Z`,
        });
      }

      const oldestPath = await findClobberFileByContent(configPath, "polluted-0\n");
      const future = new Date("2026-05-03T01:00:00.000Z");
      await fsp.utimes(oldestPath, future, future);

      await persistBoundedClobberedConfigSnapshot({
        deps: { fs, logger: { warn } },
        configPath,
        raw: "polluted-latest\n",
        observedAt: "2026-05-03T00:01:00.000Z",
      });

      const clobberFiles = await listClobberFiles(configPath);
      expect(clobberFiles).toHaveLength(CONFIG_CLOBBER_SNAPSHOT_LIMIT);
      const contents = await readClobberFileContents(configPath);
      expect(contents).not.toContain("polluted-0\n");
      expect(contents).toContain("polluted-latest\n");
      expect(warn.mock.calls).toHaveLength(1);
    });
  });

  it("keeps rotating same-timestamp async snapshots after the base artifact is reused", async () => {
    await withCase(async (configPath) => {
      const warn = vi.fn();
      const observedAt = "2026-05-03T00:00:00.000Z";

      for (let index = 0; index < CONFIG_CLOBBER_SNAPSHOT_LIMIT; index++) {
        await persistBoundedClobberedConfigSnapshot({
          deps: { fs, logger: { warn } },
          configPath,
          raw: `polluted-${index}\n`,
          observedAt,
        });
      }
      await touchClobberFilesByContentOrder(configPath);

      for (
        let index = CONFIG_CLOBBER_SNAPSHOT_LIMIT;
        index < CONFIG_CLOBBER_SNAPSHOT_LIMIT + 3;
        index++
      ) {
        await persistBoundedClobberedConfigSnapshot({
          deps: { fs, logger: { warn } },
          configPath,
          raw: `polluted-${index}\n`,
          observedAt,
        });
      }

      const clobberFiles = await listClobberFiles(configPath);
      expect(clobberFiles).toHaveLength(CONFIG_CLOBBER_SNAPSHOT_LIMIT);
      const contents = await readClobberFileContents(configPath);
      expect(contents).not.toContain("polluted-0\n");
      expect(contents).not.toContain("polluted-1\n");
      expect(contents).not.toContain("polluted-2\n");
      expect(contents).toContain(`polluted-${CONFIG_CLOBBER_SNAPSHOT_LIMIT + 2}\n`);
    });
  });

  it("rotates sync snapshots so the latest clobbered config is preserved", async () => {
    await withCase(async (configPath) => {
      const warn = vi.fn();

      for (let index = 0; index < CONFIG_CLOBBER_SNAPSHOT_LIMIT + 3; index++) {
        persistBoundedClobberedConfigSnapshotSync({
          deps: { fs, logger: { warn } },
          configPath,
          raw: `polluted-${index}\n`,
          observedAt: `2026-05-03T00:00:${String(index).padStart(2, "0")}.000Z`,
        });
      }

      const clobberFiles = await listClobberFiles(configPath);
      expect(clobberFiles).toHaveLength(CONFIG_CLOBBER_SNAPSHOT_LIMIT);
      const contents = await readClobberFileContents(configPath);
      expect(contents).not.toContain("polluted-0\n");
      expect(contents).not.toContain("polluted-1\n");
      expect(contents).not.toContain("polluted-2\n");
      expect(contents).toContain(`polluted-${CONFIG_CLOBBER_SNAPSHOT_LIMIT + 2}\n`);
      const capWarnings = warn.mock.calls.filter(
        ([message]) =>
          typeof message === "string" && message.includes("Config clobber snapshot cap reached"),
      );
      expect(capWarnings).toHaveLength(1);
    });
  });

  it("keeps rotating same-timestamp sync snapshots after the base artifact is reused", async () => {
    await withCase(async (configPath) => {
      const warn = vi.fn();
      const observedAt = "2026-05-03T00:00:00.000Z";

      for (let index = 0; index < CONFIG_CLOBBER_SNAPSHOT_LIMIT; index++) {
        persistBoundedClobberedConfigSnapshotSync({
          deps: { fs, logger: { warn } },
          configPath,
          raw: `polluted-${index}\n`,
          observedAt,
        });
      }
      touchClobberFilesByContentOrderSync(configPath);

      for (
        let index = CONFIG_CLOBBER_SNAPSHOT_LIMIT;
        index < CONFIG_CLOBBER_SNAPSHOT_LIMIT + 3;
        index++
      ) {
        persistBoundedClobberedConfigSnapshotSync({
          deps: { fs, logger: { warn } },
          configPath,
          raw: `polluted-${index}\n`,
          observedAt,
        });
      }

      const clobberFiles = await listClobberFiles(configPath);
      expect(clobberFiles).toHaveLength(CONFIG_CLOBBER_SNAPSHOT_LIMIT);
      const contents = await readClobberFileContents(configPath);
      expect(contents).not.toContain("polluted-0\n");
      expect(contents).not.toContain("polluted-1\n");
      expect(contents).not.toContain("polluted-2\n");
      expect(contents).toContain(`polluted-${CONFIG_CLOBBER_SNAPSHOT_LIMIT + 2}\n`);
    });
  });
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

function formatConfig(config: unknown): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

describe("prefixed config recovery", () => {
  it("leaves the live file unchanged when the forensic copy cannot be written", async () => {
    const home = tempDirs.make("openclaw-prefix-recovery-clobber-lock-");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const cleanRaw = formatConfig({ gateway: { mode: "local" } });
    const pollutedRaw = `Found and updated: False\n${cleanRaw}`;
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, pollutedRaw, "utf-8");
    await fsp.mkdir(`${configPath}.clobber.lock`, { mode: 0o700 });

    const warn = vi.fn();
    const io = createConfigIO({
      configPath,
      homedir: () => home,
      observe: false,
      env: {
        HOME: home,
        USERPROFILE: home,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: home,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        VITEST: "true",
      } as NodeJS.ProcessEnv,
      logger: { warn, error: vi.fn() },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(false);
    await expect(io.recoverConfigFromJsonRootSuffix(snapshot)).resolves.toBe(
      PREFIX_RECOVERY_PRESERVATION_REFUSED,
    );
    await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(pollutedRaw);
    const lockedEntries = await fsp.readdir(path.dirname(configPath));
    expect(lockedEntries.filter((name) => name.includes(".clobbered."))).toHaveLength(0);
    const warnings = warn.mock.calls.map(([message]) => String(message)).join("\n");
    expect(warnings).toContain("Config prefix recovery skipped");
    expect(warnings).toContain("could not write the .clobbered.* copy");
    expect(warnings).not.toContain("Config auto-stripped");

    await fsp.rmdir(`${configPath}.clobber.lock`);
    const retrySnapshot = await io.readConfigFileSnapshot();
    await expect(io.recoverConfigFromJsonRootSuffix(retrySnapshot)).resolves.toBe(true);
    await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(cleanRaw);
    expect(
      (await fsp.readdir(path.dirname(configPath))).filter((name) => name.includes(".clobbered.")),
    ).toHaveLength(1);
  }, 15_000);
});
