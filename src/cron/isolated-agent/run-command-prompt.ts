import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { resolveHookExternalContentSource } from "../../security/external-content-source.js";
import { appendCronJobScratchPrompt, appendCronUnattendedRunPreamble } from "../run-prompt.js";
import { readCronScratchSnapshot } from "../scratch-read.js";
import { resolveCronJobsStorePathFromConfig } from "../store/paths.js";
import {
  loadCronExternalContentRuntime,
  type RunCronAgentTurnParams,
} from "./run-prepare-runtime.js";
import { isExternalHookSession, logWarn, mapHookExternalContentSource } from "./run.runtime.js";

/** Compose the scheduled command, retaining hook fencing and the admitted scratch revision. */
export async function prepareCronCommandPrompt(params: {
  input: RunCronAgentTurnParams;
  baseSessionKey: string;
  hookExternalContentSource: ReturnType<typeof resolveHookExternalContentSource>;
  allowUnsafeExternalContent: boolean;
  message: string;
  formattedTime: string;
  timeLine: string;
  admittedConfig: OpenClawConfig;
}) {
  const {
    input,
    baseSessionKey,
    hookExternalContentSource,
    allowUnsafeExternalContent,
    message,
    formattedTime,
    timeLine,
    admittedConfig,
  } = params;
  const sourcePromptPrefix = `[cron:${input.job.id} ${input.job.name}]`;
  const base = `${sourcePromptPrefix} ${message}`.trim();
  const isExternalHook =
    hookExternalContentSource !== undefined || isExternalHookSession(baseSessionKey);
  const shouldWrapExternal = isExternalHook && !allowUnsafeExternalContent;
  let commandBody: string;

  if (isExternalHook) {
    const { detectSuspiciousPatterns } = await loadCronExternalContentRuntime();
    const suspiciousPatterns = detectSuspiciousPatterns(message);
    if (suspiciousPatterns.length > 0) {
      logWarn(
        `[security] Suspicious patterns detected in external hook content ` +
          `(session=${baseSessionKey}, patterns=${suspiciousPatterns.length}): ${suspiciousPatterns.slice(0, 3).join(", ")}`,
      );
    }
  }

  if (shouldWrapExternal) {
    const { buildSafeExternalPrompt } = await loadCronExternalContentRuntime();
    const hookType = mapHookExternalContentSource(hookExternalContentSource ?? "webhook");
    const safeContent = buildSafeExternalPrompt({
      content: message,
      source: hookType,
      jobName: input.job.name,
      jobId: input.job.id,
      timestamp: formattedTime,
    });
    commandBody = `${safeContent}\n\n${timeLine}`.trim();
  } else {
    commandBody = `${base}\n${timeLine}`.trim();
  }
  commandBody = appendCronUnattendedRunPreamble(commandBody, {
    externalHook: isExternalHook,
  });

  const scratchSnapshot = await readCronScratchSnapshot(
    resolveCronJobsStorePathFromConfig(admittedConfig),
    { kind: "job", jobId: input.job.id, createdAtMsFallback: input.job.createdAtMs },
    {},
    { assertCurrent: input.assertCurrent, signal: input.abortSignal ?? input.signal },
  );
  commandBody = appendCronJobScratchPrompt(commandBody, scratchSnapshot?.state.scratch);
  return { commandBody, isExternalHook, sourcePromptPrefix };
}
