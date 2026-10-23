type CapturedJob = {
  id: number;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  name: string;
  status: string;
  conclusion: string | null;
  runner_id: number | null;
  steps: { status: string; conclusion: string }[];
};

function completedSteps(): CapturedJob["steps"] {
  return [
    "success",
    "success",
    "success",
    "skipped",
    "skipped",
    "skipped",
    "skipped",
    "success",
    "skipped",
    "skipped",
    "success",
    "skipped",
    "success",
    "success",
  ].map((conclusion) => ({ status: "completed", conclusion }));
}

function queuedJob(id: number, steps: CapturedJob["steps"] = []): CapturedJob {
  return {
    id,
    run_id: 33155056361,
    run_attempt: 3,
    head_sha: "baa73943fbcd7b47f5432d36d4d242f8170dc141",
    name: "checks-node-changed-extensions-config-64",
    status: "queued",
    conclusion: null,
    runner_id: null,
    steps,
  };
}

function executedJob(id: number, name: string, runnerId: number): CapturedJob {
  return {
    ...queuedJob(id, completedSteps()),
    name,
    status: "completed",
    conclusion: "success",
    runner_id: runnerId,
  };
}

export default {
  provenance: {
    source: "https://github.com/openclaw/openclaw/pull/131617",
    captured: "2026-08-28",
    head: "baa73943fbcd7b47f5432d36d4d242f8170dc141",
    endpoints: [
      "GET /repos/openclaw/openclaw/actions/runs/33155056361",
      "GET /repos/openclaw/openclaw/actions/runs/33155056361/attempts/3/jobs?per_page=100&page={1,2,3}",
      "GET /repos/openclaw/openclaw/actions/jobs/{id} for all 14 queued config-64 aliases",
      "GraphQL pullRequest(number:131617).statusCheckRollup.contexts(first:100,after:$cursor)",
    ],
    trimming:
      "Keep config-62, queued config-64 and CI gate from 239 rollup nodes. Keep config-62 and ALL 15 config-64 jobs from 207 attempt jobs, in captured order. Counts/pageInfo describe the trimmed single page. Remove nonconsumed fields only. No successful config-64 CheckRun exists in the captured rollup.",
    inconsistency:
      "Four queued config-64 aliases on the last list page have 14 completed steps identical to executed job 98802098754; the other ten list aliases and ALL fourteen direct responses have steps []. Both observations are preserved. No list ordering or placeholder semantics are inferred.",
    replay:
      "Captured PR state remains MERGED here. Tests change only lifecycle state to OPEN for historical watcher replay; counterexamples explicitly mutate that baseline.",
  },
  graphql: {
    data: {
      repository: {
        pullRequest: {
          headRefOid: "baa73943fbcd7b47f5432d36d4d242f8170dc141",
          mergeable: "UNKNOWN",
          state: "MERGED",
          statusCheckRollup: {
            state: "FAILURE",
            contexts: {
              totalCount: 3,
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
              nodes: [
                {
                  checkSuite: {
                    databaseId: 89847956309,
                    workflowRun: {
                      databaseId: 33155056361,
                      event: "pull_request",
                      workflow: {
                        databaseId: 209874334,
                      },
                    },
                  },
                  conclusion: "SUCCESS",
                  databaseId: 98802098742,
                  kind: "CheckRun",
                  name: "checks-node-changed-extensions-config-62",
                  status: "COMPLETED",
                },
                {
                  checkSuite: {
                    databaseId: 89847956309,
                    workflowRun: {
                      databaseId: 33155056361,
                      event: "pull_request",
                      workflow: {
                        databaseId: 209874334,
                      },
                    },
                  },
                  conclusion: null,
                  databaseId: 98802098786,
                  kind: "CheckRun",
                  name: "checks-node-changed-extensions-config-64",
                  status: "QUEUED",
                },
                {
                  checkSuite: {
                    databaseId: 89847956309,
                    workflowRun: {
                      databaseId: 33155056361,
                      event: "pull_request",
                      workflow: {
                        databaseId: 209874334,
                      },
                    },
                  },
                  conclusion: "SUCCESS",
                  databaseId: 98802776296,
                  kind: "CheckRun",
                  name: "openclaw/ci-gate",
                  status: "COMPLETED",
                },
              ],
            },
          },
        },
      },
    },
  },
  run: {
    id: 33155056361,
    head_sha: "baa73943fbcd7b47f5432d36d4d242f8170dc141",
    run_attempt: 3,
    status: "completed",
    conclusion: "success",
    updated_at: "2026-08-28T08:55:04Z",
    path: ".github/workflows/ci.yml",
    workflow_id: 209874334,
    check_suite_id: 89847956309,
  },
  jobs: {
    total_count: 16,
    jobs: [
      queuedJob(98802098559),
      queuedJob(98802098584),
      queuedJob(98802098611),
      queuedJob(98802098636),
      queuedJob(98802098678),
      queuedJob(98802098679),
      queuedJob(98802098684),
      queuedJob(98802098721),
      queuedJob(98802098729),
      queuedJob(98802098737),
      queuedJob(98802098738, completedSteps()),
      executedJob(98802098742, "checks-node-changed-extensions-config-62", 1014005924),
      queuedJob(98802098747, completedSteps()),
      executedJob(98802098754, "checks-node-changed-extensions-config-64", 1014005923),
      queuedJob(98802098759, completedSteps()),
      queuedJob(98802098786, completedSteps()),
    ],
  },
  directJobs: [
    queuedJob(98802098559),
    queuedJob(98802098584),
    queuedJob(98802098611),
    queuedJob(98802098636),
    queuedJob(98802098678),
    queuedJob(98802098679),
    queuedJob(98802098684),
    queuedJob(98802098721),
    queuedJob(98802098729),
    queuedJob(98802098737),
    queuedJob(98802098738),
    queuedJob(98802098747),
    queuedJob(98802098759),
    queuedJob(98802098786),
  ],
};
