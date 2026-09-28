export function createPriorCiFixtureState(head: string) {
  return {
    enabled: false,
    head,
    runHead: head,
    runConclusion: "success",
    latestAttempt: 2,
    omitPullRequests: false,
    sourceRepository: { id: 1103012935, full_name: "fixture/repo" },
    runRepository: undefined as { id: number; full_name: string } | undefined,
    jobs: undefined as
      | Array<{
          id: number;
          name: string;
          status: string;
          conclusion: string;
          run_id: number;
          head_sha: string;
          check_run_url?: string;
          steps?: Array<{ number: number; name: string; status: string; conclusion: string }>;
        }>
      | undefined,
    event: "workflow_dispatch",
    branch: "topic",
    workflowPath: ".github/workflows/ci.yml",
    missingCheck: "",
    reviewDecision: "APPROVED" as string | null,
    reviewCount: 1,
    requireThreads: false,
    resolved: true,
    membership: "admin",
    evidencePath: "",
    mutateEvidence: false,
    otherCheck: "",
  };
}
