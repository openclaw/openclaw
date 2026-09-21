import fs from "node:fs";
import path from "node:path";
import { isValidAgentId, normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import JSON5 from "json5";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { CONFIG_BACKUP_COUNT } from "../config/backup-rotation.js";
import { getRecord } from "../config/legacy.shared.js";
import { isSameAuthoredSessionStoreConfig } from "../config/sessions/session-store-config.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { isRootFileMissingFailure, openRootFileSync } from "../infra/boundary-file-read.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import { sanitizeDoctorNote } from "./doctor/emit-notes.js";
import { containsAuthoredInclude } from "./doctor/shared/include-migration-ownership.js";

const OWNER_KEY = "agents.defaults.sessionStore.agentId";

type SessionStoreOwnerRecovery = {
  config: OpenClawConfig;
  changes: string[];
  warnings: string[];
};

function readBackup(backupPath: string): string | undefined {
  const opened = openRootFileSync({
    absolutePath: backupPath,
    rootPath: path.dirname(backupPath),
    boundaryLabel: "config backup directory",
  });
  if (!opened.ok) {
    if (isRootFileMissingFailure(opened)) {
      return undefined;
    }
    throw new Error("Config backup could not be read safely");
  }
  try {
    return fs.readFileSync(opened.fd, "utf8");
  } finally {
    fs.closeSync(opened.fd);
  }
}

/** Offers historical ownership without guessing whether its removal was intentional. */
export async function prepareSessionStoreOwnerRecovery(params: {
  config: OpenClawConfig;
  snapshot: Pick<ConfigFileSnapshot, "path" | "parsed" | "valid">;
  prompter?: Pick<DoctorPrompter, "confirmRuntimeRepair">;
}): Promise<SessionStoreOwnerRecovery> {
  const unchanged: SessionStoreOwnerRecovery = { config: params.config, changes: [], warnings: [] };
  if (
    !params.snapshot.valid ||
    params.config.agents?.defaults?.sessionStore?.agentId !== undefined ||
    containsAuthoredInclude(params.snapshot.parsed)
  ) {
    return unchanged;
  }
  const currentStore = getRecord(getRecord(params.snapshot.parsed)?.session)?.store;
  if (currentStore !== undefined && typeof currentStore !== "string") {
    return unchanged;
  }
  const roster = new Set(listAgentIds(params.config).map(normalizeAgentId));
  for (let index = 0; index < CONFIG_BACKUP_COUNT; index++) {
    const backupPath = `${params.snapshot.path}.bak${index === 0 ? "" : `.${index}`}`;
    let raw: string | undefined;
    let backup: unknown;
    try {
      raw = readBackup(backupPath);
      backup = raw === undefined ? undefined : JSON5.parse(raw);
    } catch {
      unchanged.warnings.push(
        `Could not inspect ${backupPath} for ${OWNER_KEY} recovery. Review that backup or re-author ${OWNER_KEY}; Doctor did not choose an owner.`,
      );
      break;
    }
    if (raw === undefined) {
      continue;
    }
    if (!isRecord(backup) || containsAuthoredInclude(backup)) {
      break;
    }
    if (backup.session !== undefined && !isRecord(backup.session)) {
      break;
    }
    const store = getRecord(backup.session)?.store;
    if (
      (store !== undefined && typeof store !== "string") ||
      !isSameAuthoredSessionStoreConfig(store, currentStore)
    ) {
      // Today's aliases cannot prove historical ownership. Never search past an authored store
      // change, even if an older backup matches again.
      break;
    }
    const owner = getRecord(getRecord(getRecord(backup.agents)?.defaults)?.sessionStore)?.agentId;
    if (owner === undefined) {
      continue;
    }
    if (
      typeof owner !== "string" ||
      !isValidAgentId(owner) ||
      !roster.has(normalizeAgentId(owner))
    ) {
      unchanged.warnings.push(
        `${OWNER_KEY} is missing, but its last backed-up value in ${backupPath} does not name a configured agent. Re-author ${OWNER_KEY} with the intended owner; Doctor did not choose one.`,
      );
      break;
    }
    const restoreCommand = formatCliCommand(`openclaw config set ${OWNER_KEY} ${owner.trim()}`);
    const accepted = await params.prompter?.confirmRuntimeRepair({
      message: sanitizeDoctorNote(
        `Restore ${OWNER_KEY}=${JSON.stringify(owner)} from ${backupPath}? Its removal may have been intentional.`,
      ),
      initialValue: false,
      requiresInteractiveConfirmation: true,
    });
    if (!accepted) {
      unchanged.warnings.push(
        `${OWNER_KEY} is missing; ${backupPath} retains ${JSON.stringify(owner)} for the unchanged session.store. The removal may have been intentional, so Doctor left it unchanged. To restore this value, run "${restoreCommand}".`,
      );
      break;
    }
    let currentBackup: string | undefined;
    try {
      currentBackup = readBackup(backupPath);
    } catch {
      // Loss of readable evidence after confirmation must leave the candidate untouched.
    }
    if (currentBackup !== raw) {
      unchanged.warnings.push(
        `${backupPath} changed or became unreadable while confirming ${OWNER_KEY}; nothing was restored. Rerun Doctor to inspect the current backup.`,
      );
      break;
    }
    const config = structuredClone(params.config);
    config.agents ??= {};
    config.agents.defaults ??= {};
    config.agents.defaults.sessionStore = {
      ...config.agents.defaults.sessionStore,
      agentId: owner,
    };
    return {
      config,
      changes: [`Restored ${OWNER_KEY}=${JSON.stringify(owner)} from ${backupPath}.`],
      warnings: [],
    };
  }
  return unchanged;
}
