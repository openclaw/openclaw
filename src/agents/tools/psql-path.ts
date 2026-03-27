import { existsSync } from "node:fs";

/** Resolve psql path once at import time — gateway's PATH may not include ~/bin. */
export const PSQL_PATH =
  [
    `${process.env.HOME}/bin/psql`,
    "/Applications/Postgres.app/Contents/Versions/14/bin/psql",
    "/opt/homebrew/bin/psql",
    "/usr/local/bin/psql",
    "psql",
  ].find((p) => p === "psql" || existsSync(p)) ?? "psql";
