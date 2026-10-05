import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { GitHubCredentialLookupError } from "../agents/github-credential-lookup-error.js";
import type { GitHubRepositoryAdmissionRequest } from "../agents/github-credential-reader.js";
import { createDiagnosticTraceContextFromActiveScope } from "../infra/diagnostic-trace-context.js";
import { readResponseWithLimit } from "../infra/http-response-body.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { FactoryGitHubProofClaim } from "./factory-github-proof.js";

const log = createSubsystemLogger("gateway/repository-admission");
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

/** Fixed private transport returns human admission facts, never a human execution bearer. */
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
  // Match the existing Factory broker client budget; private proof redemption alone permits 10s.
  const signal = AbortSignal.timeout(15_000);
  const lookupId = randomUUID();
  const trace = createDiagnosticTraceContextFromActiveScope();
  const startedAt = performance.now();
  let phase: "response" | "receipt" | "binding" = "response";
  let code = "transport_error";
  let httpStatus: number | undefined;
  let outcome: "resolved" | "rejected" = "rejected";
  try {
    const response = await fetch("http://127.0.0.1:8080/__factory__/github/repository-admission", {
      method: "GET",
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${password}`,
        "x-factory-github-proof": proof,
        "x-factory-github-lookup-id": lookupId,
      },
    });
    params.assertCurrent();
    signal.throwIfAborted();
    httpStatus = response.status;
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      code = "http_rejected";
      throw new Error("Factory repository admission refused.");
    }
    phase = "receipt";
    code = "invalid_receipt";
    const bytes = await readResponseWithLimit(response, 16 * 1024, { signal });
    params.assertCurrent();
    signal.throwIfAborted();
    const parsed = receiptSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    const { request, claim } = params;
    const receipt = parsed.success ? parsed.data : undefined;
    if (!receipt) {
      throw new Error("Factory repository admission receipt is invalid.");
    }
    phase = "binding";
    code = "binding_mismatch";
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
      code = "receipt_expired";
      throw new Error("Factory repository admission receipt expired.");
    }
    params.assertCurrent();
    signal.throwIfAborted();
    outcome = "resolved";
    code = "authorized";
  } catch {
    if (signal.aborted) {
      code = "deadline_exceeded";
    }
    try {
      params.assertCurrent();
    } catch (error) {
      code = "authority_changed";
      throw error;
    }
    throw new GitHubCredentialLookupError({
      lookupId,
      clientStage: "repository_admission",
      clientCode: code,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    });
  } finally {
    log.info("repository admission lookup", {
      traceId: trace.traceId,
      requestSpanId: trace.spanId,
      lookupId,
      operation: "repository_admission",
      phase,
      outcome,
      diagnosticCode: code,
      httpStatus,
      elapsedMs: Math.round(Math.max(0, performance.now() - startedAt)),
    });
  }
}
