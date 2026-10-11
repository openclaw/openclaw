import type { SessionTranscriptInitializationPublication } from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db-contract.js";
import type { AgentWorkerOperationContext } from "./openclaw-agent-operation-context.js";
import type { WorkerOperationHandlers } from "./worker-operation-registry.js";

type Handlers = WorkerOperationHandlers<AgentWorkerOperationContext>;
export type TranscriptInitialization = { sessionKey: string; sessionId: string; cwd?: string };

let transcript:
  | {
      initialize: typeof import("../config/sessions/session-accessor.sqlite-transcript-header.js").ensureTranscriptHeader;
      assertIdentity: typeof import("../config/sessions/session-accessor.sqlite-scope.js").assertSqliteTranscriptWriteIdentity;
      readPublication: typeof import("../config/sessions/session-transcript-authority.js").readStagedSessionTranscriptAuthority;
    }
  | undefined;

export function prepareAgentTranscript() {
  return Promise.all([
    import("../config/sessions/session-accessor.sqlite-transcript-header.js"),
    import("../config/sessions/session-accessor.sqlite-scope.js"),
    import("../config/sessions/session-transcript-authority.js"),
  ]).then(([header, scope, authority]) => {
    transcript = {
      initialize: header.ensureTranscriptHeader,
      assertIdentity: scope.assertSqliteTranscriptWriteIdentity,
      readPublication: authority.readStagedSessionTranscriptAuthority,
    };
  });
}

export async function loadAgentTranscriptOperations() {
  await prepareAgentTranscript();
  return {
    "session.transcript.initialize": (input: TranscriptInitialization, context) => {
      if (!transcript) {
        throw new Error("Session transcript initialization was not prepared");
      }
      const { initialize, readPublication } = transcript;
      const assertIdentity: typeof transcript.assertIdentity = transcript.assertIdentity;
      assertIdentity(input);
      return context.writeTransaction(
        "session.entry.create-with-transcript",
        "Session transcript",
        (current) => {
          const publication: SessionTranscriptInitializationPublication = {
            kind: "session-transcript-initialized",
            sessionKey: input.sessionKey,
          };
          initialize(
            current,
            { agentId: context.options.agentId, path: context.options.path, ...input },
            input.cwd,
            {
              onPlaceholderInserted: ({ sessionId }) => {
                publication.placeholder = { sessionId };
              },
            },
          );
          publication.transcriptPublication = readPublication(current);
          deferSqliteWorkerCommitReceipt(current.db, publication);
          context.admit("commit", publication);
          return publication;
        },
      );
    },
  } satisfies Handlers;
}

export function initializeReplacementTranscript(
  current: OpenClawAgentDatabase,
  options: Pick<AgentWorkerOperationContext["options"], "agentId" | "path">,
  initialization: TranscriptInitialization | undefined,
): void {
  if (!initialization) {
    return;
  }
  try {
    if (!transcript) {
      throw new Error("Session transcript initialization was not prepared");
    }
    const { initialize } = transcript;
    const assertIdentity: typeof transcript.assertIdentity = transcript.assertIdentity;
    assertIdentity(initialization);
    initialize(
      current,
      { agentId: options.agentId, path: options.path, ...initialization },
      initialization.cwd,
    );
  } catch (error) {
    throw Object.assign(new Error(formatErrorMessage(error), { cause: error }), {
      name: "SessionTranscriptInitializationError",
    });
  }
}
