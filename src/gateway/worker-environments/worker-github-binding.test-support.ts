import { vi } from "vitest";
import { WORKER_GITHUB_REFRESH_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import * as turnClaims from "./placement-turn-claim-events.js";
import { bindWorkerGitHubTurn } from "./worker-turn-github-binding.js";

type TurnBindingInput = Parameters<typeof bindWorkerGitHubTurn>[0];

export function turnBindingInput(
  fact: TurnBindingInput["fact"],
  overrides: Partial<
    Pick<TurnBindingInput, "assertCurrent" | "operatorAuthority" | "protocolFeatures">
  > = {},
): TurnBindingInput {
  return {
    session,
    fact,
    sessionTarget: {
      ...session,
      storePath: "/synthetic/admitted.sqlite",
      expectedWriterRunId: "writer",
    },
    store: {
      prepareTurnClaimAuthority: async () => {
        throw new Error("GitHub binding tests do not acquire turn ownership");
      },
    },
    claim: {
      sessionId: session.sessionId,
      claimId: "grant-claim",
      runId: "grant-run",
      placementGeneration: 1,
      owner: { kind: "worker", environmentId: "grant-worker", ownerEpoch: 1 },
    },
    protocolFeatures: [WORKER_GITHUB_REFRESH_PROTOCOL_FEATURE],
    signal: new AbortController().signal,
    assertCurrent: () => {},
    ...overrides,
  };
}

export async function bindPreparedGrant(
  fact: TurnBindingInput["fact"],
  assertCurrent = () => {},
  operatorAuthority?: AdmittedRunOperatorAuthority,
) {
  // Renewal tests isolate turn attachment; placement-owner tests cover admission.
  using attachment = vi.spyOn(turnClaims, "bindWorkerTurnGitHubGrant");
  attachment.mockImplementation(() => {});
  const grant = await bindWorkerGitHubTurn(
    turnBindingInput(fact, { assertCurrent, operatorAuthority }),
  );
  if (!grant) {
    throw new Error("Expected prepared grant");
  }
  return grant;
}

const profileId = "ghp_11111111111111111111111111111111";
const token = "synthetic-worker-github-binding-token";
const session = { sessionId: "worker-session", sessionKey: "agent:main:worker", agentId: "main" };
const worktree = {
  id: "worker-worktree",
  path: "/repo/worktree",
  repoRoot: "/repo",
  repoFingerprint: "repository-fingerprint",
  branch: "openclaw/session-branch",
  ownerKind: "session",
  ownerId: session.sessionKey,
};
const verified = {
  status: "available" as const,
  account: { accountId: 42, login: "shared-bot", avatarUrl: null },
  scopes: [],
};

export { profileId, session, token, verified, worktree };
