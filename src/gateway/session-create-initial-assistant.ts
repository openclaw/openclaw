import type { SessionEntry } from "../config/sessions.js";
import { prepareInitialAssistantTranscript } from "../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";
import { invalidSessionRequest, unavailableSessionRequest } from "./session-request-error.js";

type FreshSessionConstraints = {
  params: Pick<
    CreateGatewaySessionParams,
    | "initialEntry"
    | "initialAssistantMessage"
    | "fork"
    | "atomicInitialization"
    | "deviceFolder"
    | "catalogTarget"
  >;
  existingEntry: Pick<SessionEntry, "initializationPending" | "deviceFolder"> | undefined;
  sessionKey: string;
  hasWorkspacePreparation: boolean;
  hasSpawnToolPolicy: boolean;
};

/** Validate creation-only state before an existing session can be adopted. */
export function validateFreshSessionConstraints(input: FreshSessionConstraints) {
  const { params, existingEntry } = input;
  if (!params.initialEntry && existingEntry?.initializationPending === true) {
    return unavailableSessionRequest(
      `Session ${input.sessionKey} is still initializing; retry creation later.`,
    );
  }
  if (
    params.initialAssistantMessage &&
    (existingEntry !== undefined ||
      params.fork === true ||
      params.atomicInitialization === true ||
      params.initialEntry?.initializationPending === true)
  ) {
    return invalidSessionRequest(
      "initial assistant transcript requires a new session without fork or deferred initialization",
    );
  }
  if (params.initialEntry && existingEntry !== undefined) {
    return invalidSessionRequest("trusted initial session state requires a new session");
  }
  if (
    params.deviceFolder &&
    existingEntry !== undefined &&
    (existingEntry.deviceFolder?.deviceId !== params.deviceFolder.deviceId ||
      existingEntry.deviceFolder.path !== params.deviceFolder.path)
  ) {
    return invalidSessionRequest("device folder requires a new session or its original folder");
  }
  if (params.catalogTarget && existingEntry !== undefined) {
    return invalidSessionRequest("catalog session target requires a new session");
  }
  if (input.hasWorkspacePreparation && existingEntry !== undefined) {
    return invalidSessionRequest("workspace preparation requires a new session");
  }
  if (input.hasSpawnToolPolicy && existingEntry !== undefined) {
    return invalidSessionRequest("spawn tool policy requires a new session");
  }
  return undefined;
}

/** Keep the first assistant message in the same transcript transaction as the new row. */
export function withInitialAssistantTranscript<T extends object>(
  result: T,
  entry: SessionEntry,
  message: CreateGatewaySessionParams["initialAssistantMessage"],
  cwd: string | undefined,
) {
  return {
    ...result,
    entry,
    ...(message
      ? {
          transcriptEvents: prepareInitialAssistantTranscript({
            ...message,
            sessionId: entry.sessionId,
            cwd,
          }),
        }
      : {}),
  };
}
