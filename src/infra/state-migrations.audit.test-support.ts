import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { listConfigAuditRecordsForTests } from "../config/io.audit.test-support.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { listSystemAgentAuditEntriesForTests } from "../system-agent/audit.test-support.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import * as fsSafe from "./fs-safe.js";
import { detectLegacyAuditLogs, migrateLegacyAuditLogs } from "./state-migrations.audit-logs.js";

const AUDIT_SCRUB_PATTERN = Buffer.from(" \t".repeat(16));

const SYSTEM_EVENT = {
  timestamp: "2026-07-03T00:00:00.000Z",
  operation: "gateway.restart",
  summary: "",
};
const CONFIG_RECORD = {
  ts: "2026-07-01T00:00:00.000Z",
  source: "config-io",
  event: "config.write",
};
const jsonLine = (record: unknown) => `${JSON.stringify(record)}\n`;

function auditPaths(stateDir: string, relativePath: string) {
  const source = path.join(stateDir, relativePath);
  const raw = `${source}.migrated.raw`;
  return {
    source,
    sanitized: `${source}.migrated`,
    raw,
    restore: `${raw}.doctor-scrub-restore`,
    claim: path.join(path.dirname(source), `.${path.basename(source)}.doctor-importing`),
  };
}

export function systemAuditEvent(summary: string, overrides: Partial<typeof SYSTEM_EVENT> = {}) {
  return { ...SYSTEM_EVENT, summary, ...overrides };
}

export function configAuditRecord(
  marker: string,
  overrides: Partial<typeof CONFIG_RECORD> & { argv?: string[]; execArgv?: string[] } = {},
) {
  return {
    ...CONFIG_RECORD,
    argv: ["openclaw", "config", "set", "token", marker],
    execArgv: [],
    ...overrides,
  };
}

export class AuditMigrationFixture {
  readonly env: NodeJS.ProcessEnv;
  readonly config: ReturnType<typeof auditPaths>;
  readonly system: ReturnType<typeof auditPaths>;

  constructor(readonly stateDir: string) {
    this.env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    this.config = auditPaths(stateDir, path.join("logs", "config-audit.jsonl"));
    this.system = auditPaths(stateDir, path.join("audit", "system-agent.jsonl"));
  }

  detect(doctorOnlyStateMigrations = true) {
    return detectLegacyAuditLogs({
      stateDir: this.stateDir,
      doctorOnlyStateMigrations,
    });
  }

  migrate(detected = this.detect()) {
    return migrateLegacyAuditLogs({ detected, stateDir: this.stateDir });
  }

  async write(target: string, content: string | Uint8Array): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  writeJsonLines(target: string, records: unknown[]): Promise<void> {
    return this.write(target, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  }

  appendJsonLines(target: string, records: unknown[]): Promise<void> {
    return fs.appendFile(target, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  }

  async readJsonLines<T>(target: string): Promise<T[]> {
    return (await fs.readFile(target, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as T);
  }

  async seedRawArchive(paths: { raw: string; sanitized: string }, raw: string | Uint8Array) {
    await this.write(paths.sanitized, "{}\n");
    await this.write(paths.raw, raw);
  }

  systemEntries = () => listSystemAgentAuditEntriesForTests({ env: this.env });
  configRecords = () =>
    listConfigAuditRecordsForTests({ env: this.env, homedir: () => this.stateDir });
  systemSummaries = () => this.systemEntries().map((entry) => entry.value.summary);
  systemOperations = () =>
    this.systemEntries()
      .map((entry) => entry.value.operation)
      .toSorted();
}

export const withAuditMigrationFixture = (
  run: (fixture: AuditMigrationFixture) => Promise<void>,
): Promise<void> =>
  withTestDir({ prefix: "openclaw-audit-migration-" }, async (stateDir) => {
    try {
      await run(new AuditMigrationFixture(stateDir));
    } finally {
      resetPluginStateStoreForTests();
    }
  });

export function buildAuditScrubbedContent(length: number): Buffer {
  return Buffer.from(" \t".repeat(Math.ceil(length / 2))).subarray(0, length);
}

export const FIRST_AUDIT_SCRUB_BYTE = AUDIT_SCRUB_PATTERN[0]!;

export async function writeAuditRestoreJournal(
  rawPath: string,
  sourceRaw: Buffer,
  progress: { restoredBytes: number; scrubbedBytes: number } = {
    restoredBytes: 0,
    scrubbedBytes: 0,
  },
): Promise<void> {
  const stat = await fs.stat(rawPath);
  const journal = jsonLine({
    schemaVersion: 6,
    rawBase64: sourceRaw.toString("base64"),
    scrubPatternBase64: AUDIT_SCRUB_PATTERN.toString("base64"),
    target: { dev: stat.dev, ino: stat.ino, size: sourceRaw.length },
  });
  await fs.writeFile(
    `${rawPath}.doctor-scrub-progress`,
    jsonLine({
      schemaVersion: 1,
      journalHash: createHash("sha256").update(journal).digest("hex"),
      direction: progress.restoredBytes > 0 ? "restoring" : "scrubbing",
      committedBytes: progress.restoredBytes || progress.scrubbedBytes,
      pendingEnd: progress.restoredBytes || progress.scrubbedBytes,
      extentBytes: progress.restoredBytes > 0 ? progress.scrubbedBytes : sourceRaw.length,
    }),
  );
  await fs.writeFile(`${rawPath}.doctor-scrub-restore`, journal);
}

function onStateRoot(
  fixture: AuditMigrationFixture,
  opened: (root: Awaited<ReturnType<typeof fsSafe.root>>) => void,
) {
  const openRoot = fsSafe.root;
  return vi.spyOn(fsSafe, "root").mockImplementation(async (rootPath, defaults) => {
    const root = await openRoot(rootPath, defaults);
    if (rootPath === fixture.stateDir) {
      opened(root);
    }
    return root;
  });
}

export function failArchiveHardening(
  fixture: AuditMigrationFixture,
  archivePath: string,
  message: string,
) {
  const spies: Array<{ mockRestore(): void }> = [];
  let armed = true;
  const rootSpy = onStateRoot(fixture, (root) => {
    const openWritable = root.openWritable.bind(root);
    spies.push(
      vi.spyOn(root, "openWritable").mockImplementation(async (relativePath, options) => {
        const opened = await openWritable(relativePath, options);
        // Publication uses a backend-dependent chmod path; fail the explicit hardening only.
        if (
          armed &&
          options?.writeMode === "update" &&
          path.resolve(fixture.stateDir, relativePath) === archivePath
        ) {
          armed = false;
          spies.push(vi.spyOn(opened.handle, "chmod").mockRejectedValueOnce(new Error(message)));
        }
        return opened;
      }),
    );
  });
  return {
    mockRestore() {
      for (const spy of spies.toReversed()) {
        spy.mockRestore();
      }
      rootSpy.mockRestore();
    },
  };
}

/** Refuse one move at fs-safe's public boundary, leaving its source untouched. */
export function failAuditMove(
  fixture: AuditMigrationFixture,
  sourcePath: string,
  error = new fsSafe.FsSafeError(
    "helper-unavailable",
    "no-replace move and hard links unavailable",
    {
      details: {
        capability: "rename-noreplace",
        fallback: "link-unlink",
        fallbackCapability: "linkat",
      },
    },
  ),
  beforeRefusal?: () => void,
) {
  return onStateRoot(fixture, (root) => {
    const move = root.move.bind(root);
    vi.spyOn(root, "move").mockImplementation(async (...args) => {
      if (path.resolve(fixture.stateDir, args[0]) === sourcePath) {
        beforeRefusal?.();
        throw error;
      }
      return move(...args);
    });
  });
}

export async function failSecondScrubWrite(fixture: AuditMigrationFixture) {
  // The source inode becomes the raw archive; sibling publication writes must succeed.
  const sourceIdentity = await fs.stat(fixture.config.source, { bigint: true });
  const probe = await fs.open(path.join(fixture.stateDir, "write-probe"), "w+");
  type WriteArgs = [Uint8Array, number, number, number | null];
  const prototype = Object.getPrototypeOf(probe) as {
    stat(options: { bigint: true }): Promise<{ dev: bigint; ino: bigint }>;
    write(...args: WriteArgs): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
  };
  await probe.close();
  const original = Reflect.get(prototype, "write") as typeof prototype.write;
  let calls = 0;
  return vi.spyOn(prototype, "write").mockImplementation(async function (
    this: typeof prototype,
    ...args: Parameters<typeof original>
  ) {
    const [buffer, offset, length, position] = args;
    const identity = await this.stat({ bigint: true });
    if (identity.dev !== sourceIdentity.dev || identity.ino !== sourceIdentity.ino) {
      return await original.apply(this, args);
    }
    calls += 1;
    if (calls === 1) {
      const half = Math.max(1, Math.floor(length / 2));
      return await original.call(this, buffer, offset, half, position);
    }
    if (calls === 2) {
      throw new Error("simulated scrub write failure");
    }
    return await original.apply(this, args);
  });
}
