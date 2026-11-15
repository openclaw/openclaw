import { randomUUID } from "node:crypto";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";

export function usePostgresTestHarness(name: string) {
  const configured: unknown = getEnvironmentData("openclaw.test.workboard.connection");
  const connection = typeof configured === "string" ? configured : undefined;
  const prefix = `${name}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const client = new Client({ connectionString: connection });
  const closing: (() => void | Promise<void>)[] = [];
  const resetting: (() => void)[] = [];
  const directories = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(async () => {
      try {
        if (connection) {
          for (const close of closing) {
            await close();
          }
          const schemas = await client.query<{ nspname: string }>(
            "SELECT nspname FROM pg_namespace WHERE nspname = $1 OR left(nspname, $2) = $3",
            [prefix, prefix.length + 1, `${prefix}_`],
          );
          for (const { nspname } of schemas.rows) {
            await client.query(`DROP SCHEMA "${nspname.replaceAll('"', '""')}" CASCADE`);
          }
        }
      } finally {
        try {
          await client.end();
        } finally {
          for (const reset of resetting) {
            reset();
          }
          cleanup();
        }
      }
    }),
  );
  beforeAll(async () => {
    if (connection) {
      await client.connect();
    }
  });
  return {
    connection,
    prefix,
    client,
    directories,
    onClose: (close: () => void | Promise<void>) => closing.push(close),
    onReset: (reset: () => void) => resetting.push(reset),
  };
}
