import { z } from "zod";
import {
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
} from "../gateway/github-publication-availability.js";
import {
  githubPublicationPushArgs,
  githubPublicationRemoteHeadArgs,
  requirePublicationCommand,
  runPublicationCommand,
} from "../gateway/github-publication-git-transport.js";
import { githubPublicationCreatePullRequestArgs } from "../gateway/github-publication-pull-requests.js";
import {
  getSupervisedOperation,
  observeSupervisedPublication,
  prepareSupervisedPublication,
  reserveSupervisedPublicationAction,
} from "./supervised-operation.store.js";
import type {
  SupervisedOperationExecution,
  SupervisedOperationOutcome,
} from "./supervised-operation.types.js";
import {
  prepareSupervisedPublicationArtifact,
  supervisedPublicationArtifactPath,
  supervisedPublicationGitEnv,
} from "./supervised-publication-artifact.js";
import type { SupervisedWorkflowDatabaseOptions } from "./supervised-workflow.persistence.js";
import type {
  SupervisedWorkflowContract,
  SupervisedWorkflowProfile,
} from "./supervised-workflow.types.js";

export type SupervisedPublicationProfile = Extract<
  SupervisedWorkflowProfile,
  { kind: "publication" }
>;

export async function prepareSupervisedPublisher(
  profile: SupervisedPublicationProfile,
  assertCurrent: () => void,
) {
  assertCurrent();
  const identity = await prepareCurrentGitHubPublicationIdentity(profile.publisher.agentId);
  assertCurrent();
  const expected = profile.publisher;
  if (
    identity.account.accountId !== expected.accountId ||
    identity.account.login.toLowerCase() !== expected.login.toLowerCase() ||
    identity.source !== expected.source ||
    identity.profileId !== expected.profileId ||
    !matchesCurrentGitHubPublicationIdentity({ agentId: expected.agentId, identity })
  ) {
    throw new Error("Accepted publication account changed; no external action authorized");
  }
  return identity;
}

const PullSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  body: z.string().nullable(),
  user: z.object({ id: z.number().int().positive() }),
  head: z.object({
    sha: z.string(),
    ref: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
});

/** Exact external identity reconciliation always precedes a new effect. */
export async function runSupervisedPublication(params: {
  contract: SupervisedWorkflowContract;
  profile: SupervisedPublicationProfile;
  execution: SupervisedOperationExecution;
  options: SupervisedWorkflowDatabaseOptions;
  assertCurrent: () => void;
  reserveDispatch: () => void;
}): Promise<SupervisedOperationOutcome> {
  const { profile, execution, options, assertCurrent } = params;
  let identity = await prepareSupervisedPublisher(profile, assertCurrent);
  let operation = getSupervisedOperation(execution.operationId, options)!;
  if (!operation.publication) {
    const prepared = await prepareSupervisedPublicationArtifact({ ...params, identity });
    assertCurrent();
    prepareSupervisedPublication(execution, prepared, Date.now(), options);
    operation = getSupervisedOperation(execution.operationId, options)!;
  }
  const prepared = operation.publication!;
  const gitDirectory = supervisedPublicationArtifactPath(prepared.artifactId, options);
  const marker = `<!-- openclaw-supervised-operation:${operation.operationId}:${prepared.headCommit} -->`;
  const remote = `https://github.com/${profile.pushRepository}.git`;
  const refresh = async () => {
    identity = await prepareSupervisedPublisher(profile, assertCurrent);
    return supervisedPublicationGitEnv(identity);
  };
  // Even a recovered generation must acquire its own dispatch authority. The
  // prepared commit is reused exactly; no new snapshot or commit is invented.
  params.reserveDispatch();
  const remoteHead = async () => {
    const env = await refresh();
    const raw = await requirePublicationCommand(
      githubPublicationRemoteHeadArgs(remote, profile.branch),
      { env },
    );
    const entries = raw ? raw.split("\n").map((line) => line.split(/\s+/u)) : [];
    if (
      entries.length > 1 ||
      (entries.length === 1 &&
        (entries[0]?.[1] !== `refs/heads/${profile.branch}` ||
          !/^[a-f0-9]{40}$/.test(entries[0]?.[0] ?? "")))
    ) {
      throw new Error("Remote branch lookup was not an exact result");
    }
    const head = entries[0]?.[0];
    if (head === prepared.headCommit) {
      observeSupervisedPublication(execution, { remoteHead: head }, Date.now(), options);
    }
    assertCurrent();
    return head;
  };
  const previous = await remoteHead();
  if (previous !== prepared.headCommit) {
    if (previous && previous !== prepared.baseCommit) {
      throw new Error("Publication branch advanced independently; refusing overwrite");
    }
    const env = await refresh();
    reserveSupervisedPublicationAction(execution, "push", Date.now(), options);
    // A nonzero/unknown transport result is reconciled by the following read;
    // it is never interpreted as proof that the push did not happen.
    await runPublicationCommand(
      githubPublicationPushArgs(remote, prepared.headCommit, profile.branch),
      { cwd: gitDirectory, env },
    );
    if ((await remoteHead()) !== prepared.headCommit) {
      throw new Error("Prepared push has not been observed at the remote");
    }
  }
  const lookup = async () => {
    const env = await refresh();
    const raw = await requirePublicationCommand(
      [
        "gh",
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        `repos/${profile.repository}/pulls`,
        "-f",
        `head=${profile.pushRepository.split("/")[0]}:${profile.branch}`,
        "-f",
        `base=${profile.baseBranch}`,
        "-f",
        "state=all",
        "-f",
        "per_page=100",
      ],
      { env },
    );
    const candidates = z.array(PullSchema).parse(JSON.parse(raw));
    if (candidates.length >= 100) {
      throw new Error("Publication lookup requires further pagination before reuse");
    }
    const owned = candidates.filter(
      (candidate) =>
        candidate.user.id === profile.publisher.accountId &&
        candidate.head.sha === prepared.headCommit &&
        candidate.head.ref === profile.branch &&
        candidate.head.repo?.full_name.toLowerCase() === profile.pushRepository.toLowerCase() &&
        candidate.base.ref === profile.baseBranch &&
        candidate.base.repo.full_name.toLowerCase() === profile.repository.toLowerCase() &&
        candidate.body?.includes(marker),
    );
    if (owned.length > 1) {
      throw new Error("Multiple PRs claim this publication identity");
    }
    const found = owned[0];
    if (found) {
      const expectedUrl = `https://github.com/${profile.repository}/pull/${found.number}`;
      if (found.html_url.toLowerCase() !== expectedUrl.toLowerCase()) {
        throw new Error("Unexpected PR URL");
      }
      observeSupervisedPublication(
        execution,
        { pullRequestUrl: found.html_url },
        Date.now(),
        options,
      );
    }
    assertCurrent();
    if (found?.state === "closed") {
      throw new Error("Owned PR is closed; do not recreate it automatically");
    }
    if (!found && candidates.some((candidate) => candidate.state === "open")) {
      throw new Error("Publication branch has another open PR; refusing adoption");
    }
    return found;
  };
  let pull = await lookup();
  if (!pull) {
    const env = await refresh();
    reserveSupervisedPublicationAction(execution, "create", Date.now(), options);
    await runPublicationCommand(githubPublicationCreatePullRequestArgs(profile.repository), {
      env,
      input: JSON.stringify({
        title: profile.title,
        body: `${profile.body}\n\n${marker}`,
        head: `${profile.pushRepository.split("/")[0]}:${profile.branch}`,
        base: profile.baseBranch,
        draft: true,
      }),
    });
    pull = await lookup();
    if (!pull) {
      throw new Error("PR creation has not yet been observed; reconcile the exact marker");
    }
  }
  const env = await refresh();
  const signature = z
    .object({
      sha: z.string(),
      commit: z.object({ verification: z.object({ verified: z.boolean() }) }),
    })
    .parse(
      JSON.parse(
        await requirePublicationCommand(
          [
            "gh",
            "api",
            "--hostname",
            "github.com",
            `repos/${profile.pushRepository}/commits/${prepared.headCommit}`,
          ],
          { env },
        ),
      ),
    );
  assertCurrent();
  if (signature.sha !== prepared.headCommit || !signature.commit.verification.verified) {
    throw new Error("Published commit does not have a GitHub-verified signature");
  }
  return {
    status: "succeeded",
    summary: "Exact signed artifact and owned draft PR verified remotely",
    facts: {
      sourceHash: prepared.sourceHash,
      resultHash: prepared.sourceHash,
      headCommit: prepared.headCommit,
      repository: profile.repository,
      pushRepository: profile.pushRepository,
      pullRequestUrl: pull.html_url,
      pullRequestNumber: String(pull.number),
      marker,
      signature: "verified",
    },
    artifacts: [],
  };
}
