import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { legacyAuditFileIdentitiesMatch } from "./state-migrations.audit-checkpoints.js";
import {
  parseAuditRecoveryRestoreJournal as parseJournal,
  serializeAuditRecoveryRestoreJournal as serializeJournal,
} from "./state-migrations.audit-recovery-protocol.js";
import { storageProcessTestEntrypoints } from "./storage-process-runtime.test-support.js";

const sourceRaw = Buffer.from("legacy audit row\n");
const scrubPattern = Buffer.from(" \t".repeat(16));
const scrubbed = Buffer.alloc(sourceRaw.length, scrubPattern);
const refused = {
  restored: false,
  warnings: [expect.stringContaining("no longer matches its restore journal target")],
};
const upgraded = (ino: string) => ({
  restored: true,
  warnings: [],
  restoredRaw: sourceRaw.toString("utf8"),
  nextJournal: expect.objectContaining({
    schemaVersion: 7,
    target: { dev: expect.any(String), ino, size: sourceRaw.length },
  }),
});

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());

it("recovers released numeric restore journals and refuses replacement files", async ({ signal }) =>
  fixture.run(async () => {
    const scenarios = [
      { replaced: false },
      { replaced: true },
      { replaced: false, observedIno: "9007199254740993", upgrade: true },
      { replaced: true, observedIno: "9007199254740993", exact: true },
      { replaced: false, observedIno: "-1", storedIno: 18_446_744_073_709_552_000, upgrade: true },
      { replaced: true, observedIno: "-1", storedIno: "-2", exact: true },
    ];
    async function makeCase(scenario: (typeof scenarios)[number]) {
      const { replaced } = scenario;
      const directory = fixture.createTempDir("legacy-audit-restore-");
      const file = path.join(directory, "config-audit.jsonl.migrated.raw");
      const restorePath = `${file}.doctor-scrub-restore`;
      const progressPath = `${file}.doctor-scrub-progress`;
      await fs.writeFile(file, sourceRaw, { mode: 0o600 });
      const identity = await fs.stat(file);
      const legacyIno = scenario.observedIno ? Number(scenario.observedIno) : identity.ino;
      const ino = scenario.storedIno ?? (scenario.exact ? "9007199254740992" : legacyIno);
      // This is the v2026.10.2 writer's schema, independent of today's serializer.
      const journal = `${JSON.stringify({
        schemaVersion: scenario.exact ? 7 : 6,
        rawBase64: sourceRaw.toString("base64"),
        scrubPatternBase64: scrubPattern.toString("base64"),
        target: {
          dev: scenario.exact ? String(identity.dev) : identity.dev,
          ino,
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
      await fs.writeFile(file, scrubbed);
      if (replaced) {
        await fs.rename(file, `${file}.original`);
        await fs.writeFile(file, scrubbed, { mode: 0o600 });
      }
      return { directory, file, journal, ...scenario };
    }
    const cases: Awaited<ReturnType<typeof makeCase>>[] = [];
    for (const scenario of scenarios) {
      cases.push(await makeCase(scenario));
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
    expect([result.error, result.status], result.stderr).toEqual([undefined, 0]);
    expect(JSON.parse(result.stdout)).toEqual([
      { restored: true, warnings: [] },
      refused,
      upgraded("9007199254740993"),
      refused,
      upgraded("-1"),
      refused,
    ]);
    for (const { file, journal, replaced, upgrade } of cases) {
      const restorePath = `${file}.doctor-scrub-restore`;
      const progressPath = `${file}.doctor-scrub-progress`;
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
  const raw = serializeJournal({ rawBytes: sourceRaw, scrubPattern, target });
  const journal = parseJournal(raw);
  expect(journal.target).toEqual(target);
  for (const [ino, matches] of [
    [target.ino, true],
    ["9007199254740992", false],
    [9_007_199_254_740_992, true],
  ] as const) {
    expect(legacyAuditFileIdentitiesMatch(journal.target, { ...target, ino })).toBe(matches);
  }
});

it("keeps rounded numeric identities legacy and refuses them in exact journals", () => {
  const journal = {
    schemaVersion: 6,
    rawBase64: sourceRaw.toString("base64"),
    scrubPatternBase64: scrubPattern.toString("base64"),
    target: { dev: 4, ino: 9_007_199_254_740_992, size: sourceRaw.length },
  };
  const parse = (schemaVersion = 6) => parseJournal(JSON.stringify({ ...journal, schemaVersion }));
  expect(parse().target).toEqual(journal.target);
  expect(() => parse(7)).toThrow("invalid legacy audit recovery restore journal");
  expect(() =>
    serializeJournal({ rawBytes: sourceRaw, scrubPattern, target: journal.target }),
  ).toThrow("invalid legacy audit recovery restore identity");
});

it("matches signed observations with released unsigned IDs", () => {
  const observed = { dev: "-9223372036854775808", ino: "-1" };
  const legacy = { dev: 9_223_372_036_854_775_808, ino: 18_446_744_073_709_552_000 };
  for (const [left, right, matches] of [
    [legacy, observed, true],
    [observed, legacy, true],
    [observed, { ...observed, ino: "-2" }, false],
    [{ dev: 1, ino: -1 }, { dev: "1", ino: "-1" }, false],
    [{ dev: 1, ino: -1 }, { dev: 1, ino: legacy.ino }, false],
    [{ dev: 1, ino: legacy.ino }, { dev: "1", ino: "18446744073709552000" }, true],
  ] as const) {
    expect(legacyAuditFileIdentitiesMatch(left, right)).toBe(matches);
  }
});
