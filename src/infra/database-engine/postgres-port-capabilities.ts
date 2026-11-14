import type { Client } from "pg";
import { DatabasePortDataError, type PortDescriptor } from "./port-descriptor.js";

/** One capability contract for dry-run evidence and the actual copy session. */
export async function readPostgresPortCapabilities(
  db: Client,
  descriptor: Pick<PortDescriptor, "minimumPostgresVersion">,
) {
  const server = (
    await db.query<{ version: number; encoding: string; client_encoding: string }>(
      "SELECT current_setting('server_version_num')::int AS version, current_setting('server_encoding') AS encoding, current_setting('client_encoding') AS client_encoding",
    )
  ).rows[0];
  if (
    !server ||
    server.version < descriptor.minimumPostgresVersion * 10000 ||
    server.encoding !== "UTF8" ||
    server.client_encoding !== "UTF8"
  ) {
    throw new DatabasePortDataError(
      `Observed PostgreSQL ${server?.version}/${server?.encoding}/${server?.client_encoding}; required PostgreSQL >=${descriptor.minimumPostgresVersion} and UTF8 server/client`,
    );
  }
  return { version: server.version, encoding: server.encoding };
}
