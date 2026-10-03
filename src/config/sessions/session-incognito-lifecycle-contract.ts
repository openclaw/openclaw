import type {
  SqliteWorkerCommand,
  SqliteWorkerEphemeralTarget,
} from "../../infra/sqlite-worker-contract.js";
import type {
  DeleteSessionEntryLifecycleResult,
  SessionTranscriptContextVersion,
} from "./session-accessor.sqlite-contract.js";
import type {
  LifecycleArtifactCleanupInput,
  LifecycleArtifactCleanupPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import type { ParentForkSourceTranscript } from "./session-accessor.sqlite-parent-fork.js";
import type { SessionEntry } from "./types.js";

export type IncognitoLifecycleEntry = { sessionKey: string; entry: SessionEntry };
type IncognitoForkPreparation = IncognitoLifecycleEntry & {
  identity: Readonly<SqliteWorkerEphemeralTarget>;
  version: SessionTranscriptContextVersion;
  source: ParentForkSourceTranscript;
  parentSessionFile: string;
};
type IncognitoReclamationPlan = LifecycleArtifactCleanupPlan & {
  identity: Readonly<SqliteWorkerEphemeralTarget>;
};

/** Checked operations only; lifecycle hooks and companion mutations remain on the host. */
export type IncognitoLifecycleOperations = {
  "session.lifecycle.delete": {
    input: {
      target: IncognitoLifecycleEntry;
      reason: "reset" | "deleted";
      admissionIdentities: string[];
    };
    output: DeleteSessionEntryLifecycleResult;
  };
  "session.lifecycle.reclaim.prepare": {
    input: Omit<
      LifecycleArtifactCleanupInput,
      "agentId" | "continuation" | "archiveDirectory" | "archiveRemovedEntryTranscripts"
    >;
    output: IncognitoReclamationPlan;
  };
  "session.lifecycle.reclaim": {
    input: { plan: IncognitoReclamationPlan };
    output: Extract<SqliteSessionReclamationResult, { kind: "lifecycle-artifacts" }>["value"];
  };
  "session.lifecycle.fork.prepare": {
    input: { parent: IncognitoLifecycleEntry; forkFrom?: "last-completed" };
    output: IncognitoForkPreparation | undefined;
  };
  "session.lifecycle.fork": {
    input: {
      parent: IncognitoForkPreparation;
      child: IncognitoLifecycleEntry & { expectedEntry?: SessionEntry };
      cliSessionBindings?: SessionEntry["cliSessionBindings"];
    };
    output: SessionEntry;
  };
};

export function isIncognitoLifecycleCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<IncognitoLifecycleOperations> {
  return command.type.startsWith("session.lifecycle.");
}

export function isIncognitoLifecycleWrite(type: keyof IncognitoLifecycleOperations): boolean {
  return type !== "session.lifecycle.reclaim.prepare" && type !== "session.lifecycle.fork.prepare";
}

export function incognitoLifecycleKeys(
  command: SqliteWorkerCommand<IncognitoLifecycleOperations>,
  identity: Readonly<SqliteWorkerEphemeralTarget>,
): string[] {
  switch (command.type) {
    case "session.lifecycle.delete":
      return [command.input.target.sessionKey];
    case "session.lifecycle.reclaim":
      return command.input.plan.entries.map(({ sessionKey }) => sessionKey);
    case "session.lifecycle.reclaim.prepare":
      return [];
    case "session.lifecycle.fork.prepare":
      return [command.input.parent.sessionKey];
    case "session.lifecycle.fork":
      return command.input.parent.identity.handle === identity.handle &&
        command.input.parent.identity.incarnation === identity.incarnation
        ? [command.input.parent.sessionKey, command.input.child.sessionKey]
        : [command.input.child.sessionKey];
  }
  throw new Error("Unsupported incognito lifecycle operation");
}
