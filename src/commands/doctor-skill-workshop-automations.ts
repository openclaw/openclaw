import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadCronJobsStoreWithConfigJobsReadOnly,
  resolveCronJobsStorePathFromConfig,
} from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import { isMissingPathError } from "../infra/errors.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import type { SkillProposalEvent } from "../skills/workshop/types.js";
import {
  inferOwnerAgentId,
  resolveLegacyWorkshopWorkspaceDir,
  type LegacyWorkshopProposal,
} from "./doctor-skill-workshop-relocation.js";

export type WorkshopAutomationReference = {
  automationId: string;
  field: string;
  message: string;
  fixHint: string;
};

type AutomationField = { field: string; value: string; completePath: boolean };

function automationFields(job: CronJob): AutomationField[] {
  const fields: AutomationField[] = [];
  if (job.payload.kind === "command") {
    fields.push(
      ...job.payload.argv.map((value, index) => ({
        field: `payload.argv[${index}]`,
        value,
        completePath: true,
      })),
    );
    if (job.payload.cwd) {
      fields.push({ field: "payload.cwd", value: job.payload.cwd, completePath: true });
    }
  } else if (job.payload.kind === "agentTurn") {
    fields.push({ field: "payload.message", value: job.payload.message, completePath: false });
  }
  if (job.trigger) {
    fields.push({ field: "trigger.script", value: job.trigger.script, completePath: false });
  }
  return fields;
}

function containsLiteralRoot(value: string, root: string): boolean {
  for (
    let index = value.indexOf(root);
    index !== -1;
    index = value.indexOf(root, index + root.length)
  ) {
    const before = value[index - 1];
    const after = value[index + root.length];
    if (
      (!before || /[\s"'`=([{,:;]/u.test(before)) &&
      (!after || after === path.sep || /[\s"'`),\]};]/u.test(after))
    ) {
      return true;
    }
  }
  return false;
}

async function existingPath(filename: string): Promise<string | undefined> {
  try {
    return await fs.realpath(filename);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Historical apply events keep the original target after proposal retargeting. */
export async function inspectWorkshopAutomationReferences(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateEnv?: NodeJS.ProcessEnv;
  records: readonly LegacyWorkshopProposal[];
  appliedEvents: readonly SkillProposalEvent[];
}): Promise<WorkshopAutomationReference[]> {
  const records = new Map(params.records.map((entry) => [entry.record.id, entry]));
  const relocations = new Map<string, Set<string>>();
  for (const event of params.appliedEvents) {
    const entry = records.get(event.proposalId);
    const originalFile = event.payload?.targetSkillFile;
    if (
      !entry ||
      entry.record.kind !== "create" ||
      entry.record.status !== "applied" ||
      typeof originalFile !== "string" ||
      !path.isAbsolute(originalFile) ||
      path.basename(originalFile) !== "SKILL.md"
    ) {
      continue;
    }
    const source = path.dirname(originalFile);
    const destination = path.resolve(entry.record.target.skillDir);
    const { ownerAgentId } = inferOwnerAgentId({
      config: params.config,
      env: params.env,
      record: entry.record,
      workspaceDir: undefined,
      rowOwnerAgentId: entry.ownerAgentId,
    });
    if (
      !ownerAgentId ||
      !entry.ownerAgentId ||
      source === destination ||
      !resolveLegacyWorkshopWorkspaceDir(source, params.config, params.env) ||
      !isPathInside(resolveWorkshopSkillsDir(params.config, ownerAgentId, params.env), destination)
    ) {
      continue;
    }
    const destinations = relocations.get(source) ?? new Set<string>();
    destinations.add(destination);
    relocations.set(source, destinations);
  }
  if (relocations.size === 0) {
    return [];
  }
  const stateEnv = params.stateEnv ?? params.env;
  const { store } = await loadCronJobsStoreWithConfigJobsReadOnly(
    resolveCronJobsStorePathFromConfig(params.config, params.env, stateEnv),
    stateEnv,
  );
  const references: WorkshopAutomationReference[] = [];
  const orderedRelocations = [...relocations].toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const job of store.jobs.toSorted((left, right) => left.id.localeCompare(right.id))) {
    for (const { field, value, completePath } of automationFields(job)) {
      for (const [source, destinations] of orderedRelocations) {
        if (!containsLiteralRoot(value, source)) {
          continue;
        }
        const exactPath = completePath && path.isAbsolute(value) && isPathInside(source, value);
        if (await existingPath(exactPath ? value : source)) {
          continue;
        }
        let fixHint =
          "Relocation target unresolved: retained records do not identify one destination. Review this field manually.";
        if (destinations.size === 1) {
          const destination = [...destinations][0]!;
          const destinationRoot = await existingPath(destination);
          if (exactPath && destinationRoot) {
            const replacement = path.join(destination, path.relative(source, value));
            const resolved = await existingPath(replacement);
            fixHint =
              resolved && isPathInside(destinationRoot, resolved)
                ? `Verified replacement path: ${replacement}. Review this field manually; Doctor leaves automation content unchanged.`
                : "Replacement path unresolved: the mapped target is missing or outside the Workshop skill. Review this field manually.";
          } else if (destinationRoot) {
            fixHint = `Recorded directory relocation: ${source} -> ${destination}. Embedded target unresolved; review this field manually. Doctor leaves automation content unchanged.`;
          } else {
            fixHint =
              "Replacement path unresolved: the recorded Workshop destination is missing. Review this field manually.";
          }
        }
        references.push({
          automationId: job.id,
          field,
          message: `Automation ${job.id} ${field} references legacy Workshop path ${source}.`,
          fixHint,
        });
      }
    }
  }
  return references;
}
