import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type {
  ClawPackageRefStatus,
  PersistedClawPackageRef,
} from "./package-extension-provenance.js";
import { readClawPackageRefsInDatabase } from "./provenance-read.kernel.js";
import type { ClawPackage } from "./types.js";

export type { PersistedClawPackageRef } from "./package-extension-provenance.js";

export function readClawPackageRefs(
  options: OpenClawStateDatabaseOptions & {
    agentId?: string;
    kind?: ClawPackage["kind"];
    source?: ClawPackage["source"];
    ref?: string;
    version?: string;
    integrity?: string;
    status?: ClawPackageRefStatus;
  } = {},
): PersistedClawPackageRef[] {
  return readClawPackageRefsInDatabase(openOpenClawStateDatabase(options).db, options);
}
