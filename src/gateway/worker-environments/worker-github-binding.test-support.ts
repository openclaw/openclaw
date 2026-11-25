import { expect, vi } from "vitest";
import { WORKER_GITHUB_REFRESH_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { createTestConfigSnapshot } from "../../commands/test-runtime-config-helpers.js";
import {
  getRuntimeConfigSnapshotMetadata,
  notifyRuntimeConfigWriteListeners,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as turnClaims from "./placement-turn-claim-events.js";
import type { WorkerGitHubBindingGrant } from "./worker-github-binding-contract.js";
import { bindWorkerGitHubTurn } from "./worker-turn-github-binding.js";

type TurnBindingInput = Parameters<typeof bindWorkerGitHubTurn>[0];

export function publishWorkerGitHubBindingConfig(config: OpenClawConfig) {
  setRuntimeConfigSnapshot(config);
  const snapshot = createTestConfigSnapshot(config, config, "/synthetic/openclaw.json");
  notifyRuntimeConfigWriteListeners({
    configPath: snapshot.path,
    snapshot,
    sourceConfig: config,
    runtimeConfig: config,
    persistedHash: "synthetic-github-selection-update",
    ...getRuntimeConfigSnapshotMetadata()!,
  });
}

export async function expectInstalledGrantExpiresWithoutRenewal(
  fixture: {
    grant: WorkerGitHubBindingGrant;
    readonly issued: number;
    admissions: { mockImplementationOnce(wait: () => Promise<void>): unknown };
  },
  timing: "before renewal" | "while broker admission waits",
  changeSelection: () => void,
) {
  const { grant, admissions } = fixture;
  await vi.advanceTimersByTimeAsync(55 * 60_000);
  const entered = createDeferred();
  const release = createDeferred();
  let renewing: ReturnType<typeof grant.refresh> | undefined;
  if (timing === "while broker admission waits") {
    admissions.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    renewing = grant.refresh(0);
    await entered.promise;
  }
  try {
    changeSelection();
  } finally {
    release.resolve();
  }
  const replacement = await (renewing ?? grant.refresh(0));
  expect(fixture.issued).toBe(1);
  expect(replacement).toBeUndefined();
  expect(grant.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(grant.signal.aborted).toBe(true);
}

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
