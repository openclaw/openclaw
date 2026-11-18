import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { GitHubRepositoryAdmissionRequest } from "../agents/github-credential-reader.js";
import { readResponseWithLimit } from "../infra/http-response-body.js";
import type { FactoryGitHubProofClaim } from "./factory-github-proof.js";
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const receiptSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("repository-admission"),
  host: z.string(),
  appId: id,
  installationId: id,
  repository: z.strictObject({ id, fullName: z.string() }),
  actor: z.strictObject({ accountId: id, profileId: z.string().min(1) }),
  purpose: z.string(),
  binding: z.record(z.string(), z.unknown()),
  expiresAtMs: id,
});

export async function readFactoryRepositoryAdmission(params: {
  env: NodeJS.ProcessEnv;
  request: GitHubRepositoryAdmissionRequest;
  claim: FactoryGitHubProofClaim;
  profileId: string;
  assertCurrent: () => void;
}): Promise<void> {
  params.assertCurrent();
  const proof = params.env.OPENCLAW_FACTORY_GITHUB_PROOF;
  const password = params.env.OPENCLAW_GATEWAY_PASSWORD;
  const actorId = Number(params.env.OPENCLAW_FACTORY_ACTOR_ID);
  if (!proof || !password || !Number.isSafeInteger(actorId) || actorId <= 0) {
    throw new Error("Factory repository admission authority is unavailable.");
  }
  const signal = AbortSignal.timeout(15_000);
  try {
    const response = await fetch("http://127.0.0.1:8080/__factory__/github/repository-admission", {
      method: "GET",
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${password}`,
        "x-factory-github-proof": proof,
      },
    });
    params.assertCurrent();
    signal.throwIfAborted();
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error("Factory repository admission refused.");
    }
    const bytes = await readResponseWithLimit(response, 16 * 1024, { signal });
    params.assertCurrent();
    signal.throwIfAborted();
    const parsed = receiptSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    const { request, claim } = params;
    const receipt = parsed.success ? parsed.data : undefined;
    if (!receipt) {
      throw new Error("Factory repository admission receipt is invalid.");
    }
    if (
      receipt.host !== request.host ||
      receipt.appId !== request.selection.app.appId ||
      receipt.installationId !== request.selection.app.installationId ||
      request.selection.app.repositories.length !== 1 ||
      !request.selection.app.repositories.some(
        (repo) =>
          repo.id === receipt.repository.id &&
          repo.fullName.toLowerCase() === receipt.repository.fullName.toLowerCase(),
      ) ||
      receipt.actor.accountId !== actorId ||
      receipt.actor.profileId !== params.profileId ||
      receipt.purpose !== claim.purpose ||
      !isDeepStrictEqual(receipt.binding, claim.binding)
    ) {
      throw new Error("Factory repository admission changed.");
    }
    if (receipt.expiresAtMs <= Date.now()) {
      throw new Error("Factory repository admission receipt expired.");
    }
    params.assertCurrent();
    signal.throwIfAborted();
  } catch (error) {
    params.assertCurrent();
    throw new Error(
      "Factory repository admission failed; verify the signed-in actor's repository access.",
      { cause: error },
    );
  }
}
