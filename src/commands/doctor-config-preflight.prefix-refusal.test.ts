// Doctor must not treat prefix preservation refusal as last-good eligibility.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { promoteConfigSnapshotToLastKnownGood, readConfigFileSnapshot } from "../config/config.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

it("does not restore last-known-good after prefix recovery refuses preservation", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const configPath = await writeOpenClawConfig(home, {
      gateway: { mode: "local", port: 19091 },
    });
    await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot());
    const lastGoodRaw = await fs.readFile(configPath, "utf-8");
    const newerRaw = `${JSON.stringify({ gateway: { mode: "local", port: 19092 } }, null, 2)}\n`;
    const pollutedRaw = `Found and updated: False\n${newerRaw}`;
    await fs.writeFile(configPath, pollutedRaw, "utf-8");
    await fs.mkdir(`${configPath}.clobber.lock`, { mode: 0o700 });

    const failure = await runDoctorConfigPreflight({
      migrateState: false,
      migrateLegacyConfig: false,
      repairPrefixedConfig: true,
      invalidConfigNote: false,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("cannot be repaired automatically");
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(pollutedRaw);
    expect(
      (await fs.readdir(path.dirname(configPath))).filter((entry) =>
        entry.startsWith("openclaw.json.clobbered."),
      ),
    ).toEqual([]);
    await expect(fs.readFile(`${configPath}.last-good`, "utf-8")).resolves.toBe(lastGoodRaw);

    await fs.rmdir(`${configPath}.clobber.lock`);
    const repaired = await runDoctorConfigPreflight({
      migrateState: false,
      migrateLegacyConfig: false,
      repairPrefixedConfig: true,
      invalidConfigNote: false,
    });

    expect(repaired.snapshot.valid).toBe(true);
    expect(repaired.snapshot.config.gateway?.port).toBe(19092);
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(newerRaw);
    expect(
      (await fs.readdir(path.dirname(configPath))).filter((entry) =>
        entry.startsWith("openclaw.json.clobbered."),
      ),
    ).toHaveLength(1);
  });
});
