import { ok } from "@openclaw/normalization-core/result";
import { isMediaUnderstandingSkipError } from "../../packages/media-understanding-common/src/errors.js";
import type {
  MediaAttachment,
  MediaAttachmentDisposition,
  MediaAttachmentProcessing,
  MediaUnderstandingModelDecision,
  MediaUnderstandingOutput,
} from "../../packages/media-understanding-common/src/types.js";
import { isProviderAuthError } from "../agents/model-auth-runtime-shared.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import {
  failedAttachmentDisposition,
  readAudioApiKeyFailure,
} from "./media-attachment-outcomes.js";
import { assertMediaExecutionCurrent } from "./provider-execution.js";
import type { ResolvedMediaModelEntry } from "./resolve.js";
import { buildModelDecision, runCliEntry, runProviderEntry } from "./runner.entries.js";

export async function runAttachmentEntries(
  params: Omit<
    Parameters<typeof runProviderEntry>[0],
    "entry" | "attachmentIndex" | "secretOwnerId"
  > & {
    ctx: MsgContext;
    attachment: MediaAttachment;
    entries: Iterable<ResolvedMediaModelEntry> | AsyncIterable<ResolvedMediaModelEntry>;
    automaticAudio: boolean;
  },
): Promise<{
  output: MediaUnderstandingOutput | null;
  attempts: MediaUnderstandingModelDecision[];
  processing: MediaAttachmentProcessing;
  failed?: MediaAttachmentDisposition;
}> {
  const { entries, capability } = params;
  const attachmentIndex = params.attachment.index;
  const attempts: MediaUnderstandingModelDecision[] = [];
  let processing: MediaAttachmentProcessing = "omitted";
  // The first failure is the one the operator summary reports, so the marker keeps the same one.
  let failed: MediaAttachmentDisposition | undefined;
  const recordFailure = async (
    entry: MediaUnderstandingModelConfig,
    entryType: "provider" | "cli",
    error: unknown,
    skipMissingAuth = false,
  ) => {
    const missingAuth = skipMissingAuth && isProviderAuthError(error, "missing-provider-auth");
    const provider =
      !failed && capability === "audio"
        ? await readAudioApiKeyFailure(error, params.agentDir)
        : undefined;
    if (missingAuth && !provider) {
      return;
    }
    failed ??= provider
      ? { kind: "failed", apiKeyRequired: provider }
      : failedAttachmentDisposition(error);
    attempts.push(
      buildModelDecision({ entry, entryType, outcome: "failed", reason: String(error) }),
    );
  };
  for await (const candidate of entries) {
    const { entry } = candidate;
    const entryType = entry.type ?? (entry.command ? "cli" : "provider");
    try {
      const attempt =
        entryType === "cli"
          ? ok(await runCliEntry({ ...params, entry }))
          : await runProviderEntry({
              ...params,
              entry,
              attachmentIndex,
              secretOwnerId: candidate.secretOwnerId,
            });
      assertMediaExecutionCurrent(params.execution);
      if (!attempt.ok) {
        await recordFailure(entry, entryType, attempt.error, params.automaticAudio);
        continue;
      }
      const result = attempt.value;
      // Successful empty CLI/API output was processed; unavailable auth was not.
      processing = "completed";
      if (result?.text) {
        const decision = buildModelDecision({ entry, entryType, outcome: "success" });
        if (result.provider) {
          decision.provider = result.provider;
        }
        decision.model = result.model;
        if (result.requestedBackend) {
          decision.requestedBackend = result.requestedBackend;
        }
        if (result.observedBackend) {
          decision.observedBackend = result.observedBackend;
        }
        attempts.push(decision);
        return { output: result, attempts, processing };
      }
      attempts.push(
        buildModelDecision({ entry, entryType, outcome: "skipped", reason: "empty output" }),
      );
    } catch (err) {
      assertMediaExecutionCurrent(params.execution);
      if (isMediaUnderstandingSkipError(err)) {
        attempts.push(
          buildModelDecision({
            entry,
            entryType,
            outcome: "skipped",
            reason: `${err.reason}: ${err.message}`,
          }),
        );
        if (shouldLogVerbose()) {
          logVerbose(`Skipping ${capability} model due to ${err.reason}: ${err.message}`);
        }
      } else {
        await recordFailure(entry, entryType, err);
        if (shouldLogVerbose()) {
          logVerbose(`${capability} understanding failed: ${String(err)}`);
        }
      }
    }
    if (params.automaticAudio && entryType === "provider") {
      break;
    }
  }

  return { output: null, attempts, processing, failed };
}
