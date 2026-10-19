import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { legacyAuditFileIdentitiesMatch } from "./state-migrations.audit-checkpoints.js";
import {
  parseAuditRecoveryRestoreJournal,
  serializeAuditRecoveryRestoreJournal,
} from "./state-migrations.audit-recovery-protocol.js";
import { storageProcessTestEntrypoints } from "./storage-process-runtime.test-support.js";

const sourceRaw = Buffer.from("legacy audit row\n");
const scrubPattern = Buffer.from(" \t".repeat(16));

describe("legacy audit recovery identity persistence", () => {
  const fixture = createFixtureLifetime();
  afterEach(() => fixture.cleanup());

  it("recovers released numeric restore journals and refuses replacement files", async ({
    signal,
  }) =>
    fixture.run(async () => {
      const cases: {
        directory: string;
        file: string;
        restorePath: string;
        progressPath: string;
        journal: string;
        scrubbed: Buffer;
        replaced: boolean;
        observedIno?: string;
        upgrade?: boolean;
      }[] = [];
      for (const scenario of [
        { replaced: false },
        { replaced: true },
        { replaced: false, observedIno: "9007199254740993", upgrade: true },
        { replaced: true, observedIno: "9007199254740993", exact: true },
        {
          replaced: false,
          observedIno: "-1",
          storedIno: 18_446_744_073_709_552_000,
          upgrade: true,
        },
        { replaced: true, observedIno: "-1", storedIno: "-2", exact: true },
      ]) {
        const { replaced } = scenario;
        const directory = fixture.createTempDir("legacy-audit-restore-");
        const file = path.join(directory, "config-audit.jsonl.migrated.raw");
        const restorePath = `${file}.doctor-scrub-restore`;
        const progressPath = `${file}.doctor-scrub-progress`;
        await fs.writeFile(file, sourceRaw, { mode: 0o600 });
        const identity = await fs.stat(file);
        // This is the v2026.10.2 writer's schema, independent of today's serializer.
        const journal = `${JSON.stringify({
          schemaVersion: scenario.exact ? 7 : 6,
          rawBase64: sourceRaw.toString("base64"),
          scrubPatternBase64: scrubPattern.toString("base64"),
          target: {
            dev: scenario.exact ? String(identity.dev) : identity.dev,
            ino:
              scenario.storedIno ??
              (scenario.exact
                ? "9007199254740992"
                : scenario.observedIno
                  ? Number(scenario.observedIno)
                  : identity.ino),
            size: sourceRaw.length,
          },
        })}\n`;
        await fs.writeFile(restorePath, journal, { mode: 0o600 });
        await fs.writeFile(
          progressPath,
          JSON.stringify({
            schemaVersion: 1,
            journalHash: createHash("sha256").update(journal).digest("hex"),
            direction: "scrubbing",
            committedBytes: sourceRaw.length,
            pendingEnd: sourceRaw.length,
            extentBytes: sourceRaw.length,
          }),
          { mode: 0o600 },
        );
        const scrubbed = Buffer.alloc(sourceRaw.length, scrubPattern);
        await fs.writeFile(file, scrubbed);
        if (replaced) {
          await fs.rename(file, `${file}.original`);
          await fs.writeFile(file, scrubbed, { mode: 0o600 });
        }
        cases.push({ directory, file, restorePath, progressPath, journal, scrubbed, ...scenario });
      }
      // Bun on Windows releases retained SQLite resources when the owning process exits.
      const result = await fixture.track(
        runNodeScript(
          (workerArgv) => [
            ...workerArgv(resolveRuntimeWorkerUrl(storageProcessTestEntrypoints.auditRecovery)),
            JSON.stringify(
              cases.map(({ directory, observedIno, upgrade }) => ({
                directory,
                observedIno,
                upgrade,
              })),
            ),
          ],
          process.env,
          undefined,
          { signal, executable: process.execPath, maxBuffer: 64 * 1024 },
        ),
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        { restored: true, warnings: [] },
        {
          restored: false,
          warnings: [expect.stringContaining("no longer matches its restore journal target")],
        },
        {
          restored: true,
          warnings: [],
          restoredRaw: sourceRaw.toString("utf8"),
          nextJournal: expect.objectContaining({
            schemaVersion: 7,
            target: {
              dev: expect.any(String),
              ino: "9007199254740993",
              size: sourceRaw.length,
            },
          }),
        },
        {
          restored: false,
          warnings: [expect.stringContaining("no longer matches its restore journal target")],
        },
        {
          restored: true,
          warnings: [],
          restoredRaw: sourceRaw.toString("utf8"),
          nextJournal: expect.objectContaining({
            schemaVersion: 7,
            target: {
              dev: expect.any(String),
              ino: "-1",
              size: sourceRaw.length,
            },
          }),
        },
        {
          restored: false,
          warnings: [expect.stringContaining("no longer matches its restore journal target")],
        },
      ]);
      for (const {
        file,
        restorePath,
        progressPath,
        journal,
        scrubbed,
        replaced,
        upgrade,
      } of cases) {
        if (replaced) {
          expect(await fs.readFile(file)).toEqual(scrubbed);
          expect(await fs.readFile(restorePath, "utf8")).toBe(journal);
        } else if (!upgrade) {
          expect(await fs.readFile(file)).toEqual(sourceRaw);
          await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(fs.access(progressPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
    }));

  it("round-trips adjacent Windows file IDs above the numeric precision limit", () => {
    const target = { dev: "4", ino: "9007199254740993", size: sourceRaw.length };
    const raw = serializeAuditRecoveryRestoreJournal({ rawBytes: sourceRaw, scrubPattern, target });
    const journal = parseAuditRecoveryRestoreJournal(raw);
    expect(journal.target).toEqual(target);
    expect(legacyAuditFileIdentitiesMatch(journal.target, target)).toBe(true);
    expect(
      legacyAuditFileIdentitiesMatch(journal.target, { ...target, ino: "9007199254740992" }),
    ).toBe(false);
    expect(
      legacyAuditFileIdentitiesMatch(journal.target, { ...target, ino: 9_007_199_254_740_992 }),
    ).toBe(true);
  });

  it("keeps rounded numeric identities legacy and refuses them in exact journals", () => {
    const journal = {
      schemaVersion: 6,
      rawBase64: sourceRaw.toString("base64"),
      scrubPatternBase64: scrubPattern.toString("base64"),
      target: { dev: 4, ino: 9_007_199_254_740_992, size: sourceRaw.length },
    };
    expect(parseAuditRecoveryRestoreJournal(JSON.stringify(journal)).target).toEqual(
      journal.target,
    );
    expect(() =>
      parseAuditRecoveryRestoreJournal(JSON.stringify({ ...journal, schemaVersion: 7 })),
    ).toThrow("invalid legacy audit recovery restore journal");
    expect(() =>
      serializeAuditRecoveryRestoreJournal({
        rawBytes: sourceRaw,
        scrubPattern,
        target: journal.target,
      }),
    ).toThrow("invalid legacy audit recovery restore identity");
  });

  it("projects high-bit observations as released unsigned stats without changing retained numbers", () => {
    const observed = { dev: "-9223372036854775808", ino: "-1" };
    const legacy = { dev: 9_223_372_036_854_775_808, ino: 18_446_744_073_709_552_000 };
    expect(legacyAuditFileIdentitiesMatch(legacy, observed)).toBe(true);
    expect(legacyAuditFileIdentitiesMatch(observed, legacy)).toBe(true);
    expect(legacyAuditFileIdentitiesMatch(observed, { ...observed, ino: "-2" })).toBe(false);
    expect(legacyAuditFileIdentitiesMatch({ dev: 1, ino: -1 }, { dev: "1", ino: "-1" })).toBe(
      false,
    );
    expect(legacyAuditFileIdentitiesMatch({ dev: 1, ino: -1 }, { dev: 1, ino: legacy.ino })).toBe(
      false,
    );
    expect(
      legacyAuditFileIdentitiesMatch(
        { dev: 1, ino: legacy.ino },
        { dev: "1", ino: "18446744073709552000" },
      ),
    ).toBe(true);
  });
});
