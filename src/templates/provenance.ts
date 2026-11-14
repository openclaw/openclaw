import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type {
  TemplatePackageRefStatus,
  PersistedTemplatePackageRef,
} from "./package-extension-provenance.js";
import { readTemplatePackageRefsInDatabase } from "./provenance-read.kernel.js";
import type { TemplatePackage } from "./types.js";

export type { PersistedTemplatePackageRef } from "./package-extension-provenance.js";

export function readTemplatePackageRefs(
  options: OpenClawStateDatabaseOptions & {
    agentId?: string;
    kind?: TemplatePackage["kind"];
    source?: TemplatePackage["source"];
    ref?: string;
    version?: string;
    integrity?: string;
    status?: TemplatePackageRefStatus;
  } = {},
): PersistedTemplatePackageRef[] {
  return readTemplatePackageRefsInDatabase(openOpenClawStateDatabase(options).db, options);
}
