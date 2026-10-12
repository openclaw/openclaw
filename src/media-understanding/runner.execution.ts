// Executes one attachment's ordered provider/CLI candidates without admitting
// another attempt after the caller cancels.
import { ok } from "@openclaw/normalization-core/result";
import { isMediaUnderstandingSkipError } from "../../packages/media-understanding-common/src/errors.js";
import { isProviderAuthError } from "../agents/model-auth-runtime-shared.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import type { ResolvedMediaModelEntry } from "./resolve.js";
import { buildModelDecision, runCliEntry, runProviderEntry } from "./runner.entries.js";
import type {
  MediaAttachment,
  MediaAttachmentProcessing,
  MediaUnderstandingModelDecision,
  MediaUnderstandingOutput,
} from "./types.js";

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
}> {
  params.signal?.throwIfAborted();
  const { entries, capability } = params;
  const attachmentIndex = params.attachment.index;
  const attempts: MediaUnderstandingModelDecision[] = [];
  let processing: MediaAttachmentProcessing = "omitted";
  for await (const candidate of entries) {
    params.signal?.throwIfAborted();
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
      params.signal?.throwIfAborted();
      if (!attempt.ok) {
        if (
          !(params.automaticAudio && isProviderAuthError(attempt.error, "missing-provider-auth"))
        ) {
          attempts.push(
            buildModelDecision({
              entry,
              entryType,
              outcome: "failed",
              reason: String(attempt.error),
            }),
          );
        }
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
      params.signal?.throwIfAborted();
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
        attempts.push(
          buildModelDecision({
            entry,
            entryType,
            outcome: "failed",
            reason: String(err),
          }),
        );
        if (shouldLogVerbose()) {
          logVerbose(`${capability} understanding failed: ${String(err)}`);
        }
      }
    }
    if (params.automaticAudio && entryType === "provider") {
      break;
    }
  }

  params.signal?.throwIfAborted();
  return { output: null, attempts, processing };
}
