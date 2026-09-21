// Doctor gateway methods inspect and repair memory dreaming artifacts and managed cron state.
import { expectDefined } from "@openclaw/normalization-core";
import {
  resolveMemoryDreamingPluginConfig,
  resolveMemoryRemDreamingConfig,
} from "../../memory-host-sdk/dreaming.js";
import * as defaultMemoryCoreRuntime from "../../plugin-sdk/memory-core-bundled-runtime.js";
import {
  listWorkspaceDailyFiles,
  readDreamDiary,
  type DoctorMemoryDreamDiaryPayload,
} from "./doctor-memory-files.js";
import {
  createDoctorMemoryStatusHandler,
  resolveDoctorMemoryTarget,
} from "./doctor-memory-status.js";
import type { GatewayRequestHandlers } from "./types.js";

export type { DoctorMemoryDreamDiaryPayload } from "./doctor-memory-files.js";
export type {
  DoctorMemoryEmbeddingRuntimePayload,
  DoctorMemoryStatusPayload,
} from "./doctor-memory-status.js";

type DoctorMemoryCoreRuntime = Pick<
  typeof defaultMemoryCoreRuntime,
  | "dedupeDreamDiaryEntries"
  | "loadShortTermPromotionDreamingStats"
  | "previewGroundedRemMarkdown"
  | "removeBackfillDiaryEntries"
  | "removeGroundedShortTermCandidates"
  | "repairDreamingArtifacts"
  | "writeBackfillDiaryEntries"
>;

export type DoctorMemoryDreamActionPayload = {
  agentId: string;
  action:
    | "backfill"
    | "reset"
    | "resetGroundedShortTerm"
    | "repairDreamingArtifacts"
    | "dedupeDreamDiary";
  path?: string;
  found?: boolean;
  scannedFiles?: number;
  written?: number;
  replaced?: number;
  removedEntries?: number;
  removedShortTermEntries?: number;
  changed?: boolean;
  archiveDir?: string;
  archivedDreamsDiary?: boolean;
  archivedSessionCorpus?: boolean;
  archivedSessionIngestion?: boolean;
  warnings?: string[];
  dedupedEntries?: number;
  keptEntries?: number;
};

function extractIsoDayFromPath(filePath: string): string | null {
  const match = filePath.replaceAll("\\", "/").match(/(\d{4}-\d{2}-\d{2})(?:-[^/]+)?\.md$/i);
  return match?.[1] ?? null;
}

function groundedMarkdownToDiaryLines(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.replace(/^##\s+/, "").trimEnd())
    .filter(
      (line, index, lines) =>
        line.length > 0 ||
        (index > 0 && expectDefined(lines[index - 1], "lines entry at index 1")?.length > 0),
    );
}

export const createDoctorHandlers = (
  memoryCoreRuntime: DoctorMemoryCoreRuntime = defaultMemoryCoreRuntime,
): GatewayRequestHandlers => ({
  "doctor.memory.status": createDoctorMemoryStatusHandler(memoryCoreRuntime),
  "doctor.memory.dreamDiary": async ({ respond, context, params }) => {
    const target = resolveDoctorMemoryTarget(context, params, respond);
    if (!target) {
      return;
    }
    const { agentId, workspaceDir } = target;
    const dreamDiary = await readDreamDiary(workspaceDir);
    const payload: DoctorMemoryDreamDiaryPayload = {
      agentId,
      ...dreamDiary,
    };
    respond(true, payload, undefined);
  },
  "doctor.memory.backfillDreamDiary": async ({ respond, context, params }) => {
    const target = resolveDoctorMemoryTarget(context, params, respond);
    if (!target) {
      return;
    }
    const { cfg, agentId, workspaceDir } = target;
    const sourceFiles = await listWorkspaceDailyFiles(workspaceDir);
    if (sourceFiles.length === 0) {
      const dreamDiary = await readDreamDiary(workspaceDir);
      const payload: DoctorMemoryDreamActionPayload = {
        agentId,
        path: dreamDiary.path,
        action: "backfill",
        found: dreamDiary.found,
        scannedFiles: 0,
        written: 0,
        replaced: 0,
      };
      respond(true, payload, undefined);
      return;
    }
    const grounded = await memoryCoreRuntime.previewGroundedRemMarkdown({
      workspaceDir,
      inputPaths: sourceFiles,
    });
    const remConfig = resolveMemoryRemDreamingConfig({
      pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
      cfg,
    });
    const entries = grounded.files
      .map((file) => {
        const isoDay = extractIsoDayFromPath(file.path);
        if (!isoDay) {
          return null;
        }
        return {
          isoDay,
          sourcePath: file.path,
          bodyLines: groundedMarkdownToDiaryLines(file.renderedMarkdown),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const written = await memoryCoreRuntime.writeBackfillDiaryEntries({
      workspaceDir,
      entries,
      timezone: remConfig.timezone,
    });
    const dreamDiary = await readDreamDiary(workspaceDir);
    const payload: DoctorMemoryDreamActionPayload = {
      agentId,
      path: dreamDiary.path,
      action: "backfill",
      found: dreamDiary.found,
      scannedFiles: grounded.scannedFiles,
      written: written.written,
      replaced: written.replaced,
    };
    respond(true, payload, undefined);
  },
  "doctor.memory.resetDreamDiary": async ({ respond, context, params }) => {
    const target = resolveDoctorMemoryTarget(context, params, respond);
    if (!target) {
      return;
    }
    const { agentId, workspaceDir } = target;
    const removed = await memoryCoreRuntime.removeBackfillDiaryEntries({ workspaceDir });
    const dreamDiary = await readDreamDiary(workspaceDir);
    const payload: DoctorMemoryDreamActionPayload = {
      agentId,
      path: dreamDiary.path,
      action: "reset",
      found: dreamDiary.found,
      removedEntries: removed.removed,
    };
    respond(true, payload, undefined);
  },
  "doctor.memory.resetGroundedShortTerm": async ({ respond, context, params }) => {
    const target = resolveDoctorMemoryTarget(context, params, respond);
    if (!target) {
      return;
    }
    const { agentId, workspaceDir } = target;
    const removed = await memoryCoreRuntime.removeGroundedShortTermCandidates({ workspaceDir });
    const payload: DoctorMemoryDreamActionPayload = {
      agentId,
      action: "resetGroundedShortTerm",
      removedShortTermEntries: removed.removed,
    };
    respond(true, payload, undefined);
  },
  "doctor.memory.repairDreamingArtifacts": async ({ respond, context, params }) => {
    const target = resolveDoctorMemoryTarget(context, params, respond);
    if (!target) {
      return;
    }
    const { agentId, workspaceDir } = target;
    const repair = await memoryCoreRuntime.repairDreamingArtifacts({ workspaceDir });
    const payload: DoctorMemoryDreamActionPayload = {
      agentId,
      action: "repairDreamingArtifacts",
      changed: repair.changed,
      archiveDir: repair.archiveDir,
      archivedDreamsDiary: repair.archivedDreamsDiary,
      archivedSessionCorpus: repair.archivedSessionCorpus,
      archivedSessionIngestion: repair.archivedSessionIngestion,
      warnings: repair.warnings,
    };
    respond(true, payload, undefined);
  },
  "doctor.memory.dedupeDreamDiary": async ({ respond, context, params }) => {
    const target = resolveDoctorMemoryTarget(context, params, respond);
    if (!target) {
      return;
    }
    const { agentId, workspaceDir } = target;
    const dedupe = await memoryCoreRuntime.dedupeDreamDiaryEntries({ workspaceDir });
    const dreamDiary = await readDreamDiary(workspaceDir);
    const payload: DoctorMemoryDreamActionPayload = {
      agentId,
      action: "dedupeDreamDiary",
      path: dreamDiary.path,
      found: dreamDiary.found,
      removedEntries: dedupe.removed,
      dedupedEntries: dedupe.removed,
      keptEntries: dedupe.kept,
    };
    respond(true, payload, undefined);
  },
});
