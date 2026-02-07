import { createRequire } from "node:module";
import { installProcessWarningFilter } from "../infra/warnings.js";

const require = createRequire(import.meta.url);

export function requireNodeSqlite(): typeof import("node:sqlite") {
  installProcessWarningFilter();
  return require("node:sqlite") as typeof import("node:sqlite");
}
