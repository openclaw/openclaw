import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readSkillProposalManifest, readSkillProposalRecord } from "./store.js";

export async function getSkillProposalRunProgress(options: {
  agentId: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  runId: string;
}): Promise<{ mutationCount: number; proposalIds: string[] }> {
  const manifest = await readSkillProposalManifest(options, options);
  const ids: string[] = [];
  let mutationCount = 0;
  for (const proposal of manifest.proposals) {
    const record = await readSkillProposalRecord(proposal.id, options, options, {
      config: options.config,
    });
    if (!record) {
      continue;
    }
    if (record.origin?.runId === options.runId || record.originRunIds?.includes(options.runId)) {
      ids.push(record.id);
      mutationCount += record.originRunMutationCounts?.[options.runId] ?? 1;
    }
  }
  return { mutationCount, proposalIds: ids };
}
