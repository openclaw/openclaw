import { openNodeSqliteDatabase } from "../node-sqlite.js";
import type { PortDescriptor } from "./port-descriptor.js";
import { inspectDatabasePort, type PortVerification } from "./port.worker.js";

/** The caller owns this private SQLite copy and retains custody through verification. */
export async function migrateDatabasePortSource(
  sourcePath: string,
  descriptor: PortDescriptor,
  sourceVersion: number,
  assertCurrent: () => void,
): Promise<PortVerification> {
  assertCurrent();
  await descriptor.migrateSqliteSource?.(sourcePath, sourceVersion, assertCurrent);
  using db = openNodeSqliteDatabase(sourcePath, { readOnly: true, readBigInts: true });
  const source = { engine: "sqlite" as const, db };
  const { catalog: _catalog, ...verification } = await inspectDatabasePort(source, descriptor);
  return verification;
}
