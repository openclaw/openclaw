type ReleaseWorkflowJob = { needs?: string | string[]; "timeout-minutes"?: number | string };

export function releaseWorkflowJobNeeds(job: ReleaseWorkflowJob): string[] {
  return Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
}
