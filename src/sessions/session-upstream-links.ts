/** Best-effort shared-state registry for adopted upstream sessions. */
import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";
import {
  upsertSessionUpstreamLinkInDatabase,
  deleteSessionUpstreamLinkInDatabase,
  type SessionUpstreamLink,
  type SessionUpstreamLinkInput,
} from "./session-upstream-links.kernel.js";
import type { SessionUpstreamLinkCurrentCheck } from "./session-upstream-links.worker-contract.js";

export type { SessionUpstreamLink } from "./session-upstream-links.kernel.js";

const log = createSubsystemLogger("sessions/upstream-links");

/** @deprecated Use upsertSessionUpstreamLinkAsync. Removed at the next Plugin SDK major. */
export function upsertSessionUpstreamLink(
  input: SessionUpstreamLinkInput,
  options: OpenClawStateDatabaseOptions & {
    now?: number;
    ifAbsent?: true;
    assertCommitAllowed?: () => void;
  } = {},
): boolean {
  const now = options.now ?? Date.now();
  try {
    return runOpenClawStateWriteTransaction(({ db }) => {
      options.assertCommitAllowed?.();
      const written = upsertSessionUpstreamLinkInDatabase(db, input, now, options.ifAbsent);
      // Revalidate before COMMIT: a lifecycle change must roll back this link write.
      options.assertCommitAllowed?.();
      return written;
    }, options);
  } catch (error) {
    if (options.ifAbsent) {
      throw error;
    }
    log.warn(`failed to upsert session upstream link: ${String(error)}`);
    return false;
  }
}

/** @deprecated Use deleteSessionUpstreamLinkAsync. Removed at the next Plugin SDK major. */
export function deleteSessionUpstreamLink(
  sessionKey: string,
  agentId: string,
  options: OpenClawStateDatabaseOptions & {
    expected?: SessionUpstreamLink;
    assertCommitAllowed?: () => void;
  } = {},
): "deleted" | "absent" | "changed" | undefined {
  try {
    return runOpenClawStateWriteTransaction(({ db }) => {
      options.assertCommitAllowed?.();
      const result = deleteSessionUpstreamLinkInDatabase(db, sessionKey, agentId, options.expected);
      if (result === "deleted") {
        options.assertCommitAllowed?.();
      }
      return result;
    }, options);
  } catch (error) {
    // Exact creation compensation must report an unverified cleanup, not claim success.
    if (options.expected) {
      throw error;
    }
    log.warn(`failed to delete session upstream link: ${String(error)}`);
    return undefined;
  }
}

type UpstreamWriteOptions = Pick<
  OpenClawStateDatabaseOptions,
  "env" | "path" | "initializationAgentPaths"
>;

export async function upsertSessionUpstreamLinkAsync(
  input: SessionUpstreamLinkInput,
  options: UpstreamWriteOptions & {
    now?: number;
    ifAbsent?: true;
    assertCommitAllowed?: () => void;
  } = {},
): Promise<boolean> {
  return upsertSessionUpstreamLinkWithCurrentSource(input, options);
}

/** Internal initializer adapter; source authority is never part of the public SDK arguments. */
export async function upsertSessionUpstreamLinkWithCurrentSource(
  input: SessionUpstreamLinkInput,
  options: NonNullable<Parameters<typeof upsertSessionUpstreamLinkAsync>[1]>,
  source?: SessionUpstreamLinkCurrentCheck,
): Promise<boolean> {
  try {
    const context = source?.context ?? captureOpenClawStateWorkerContext(options);
    const command = {
      type: "sessionUpstream.upsert" as const,
      input: structuredClone({
        link: input,
        now: options.now ?? Date.now(),
        ifAbsent: options.ifAbsent,
        source: source?.expected,
      }),
    };
    const assertCurrent = () => {
      context.admission.assertCurrent();
      if (source) {
        source.withCurrent(() => options.assertCommitAllowed?.());
      } else {
        options.assertCommitAllowed?.();
      }
    };
    return await runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command), {
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
        context.admission.databasePath,
      ]),
    });
  } catch (error) {
    if (options.ifAbsent) {
      throw error;
    }
    log.warn(`failed to upsert session upstream link: ${String(error)}`);
    return false;
  }
}

export async function deleteSessionUpstreamLinkAsync(
  sessionKey: string,
  agentId: string,
  options: UpstreamWriteOptions & {
    expected?: SessionUpstreamLink;
    assertCommitAllowed?: () => void;
  } = {},
): Promise<ReturnType<typeof deleteSessionUpstreamLink>> {
  try {
    const context = captureOpenClawStateWorkerContext(options);
    const input = structuredClone({ sessionKey, agentId, expected: options.expected });
    const assertCurrent = () => {
      context.admission.assertCurrent();
      options.assertCommitAllowed?.();
    };
    return await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "sessionUpstream.delete", input }),
      {
        assertCurrent,
        createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
          context.admission.databasePath,
        ]),
      },
    );
  } catch (error) {
    if (options.expected) {
      throw error;
    }
    log.warn(`failed to delete session upstream link: ${String(error)}`);
    return undefined;
  }
}

export async function listWatchedSessionUpstreamLinks(
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
): Promise<Map<string, SessionUpstreamLink[]>> {
  const grouped = new Map<string, SessionUpstreamLink[]>();
  try {
    const links = await executeOpenClawStateWorker(captureOpenClawStateWorkerContext(options), {
      type: "sessionUpstream.listWatched",
      input: undefined,
    });
    // Fail closed on the single-agent-per-key invariant: the key-only cursor lookup
    // cannot disambiguate multiple agents sharing the exact same adopted key.
    // Drop every link for that key rather than probe an arbitrary agent's upstream.
    const keyCounts = new Map<string, number>();
    for (const link of links) {
      keyCounts.set(link.sessionKey, (keyCounts.get(link.sessionKey) ?? 0) + 1);
    }
    for (const link of links) {
      if ((keyCounts.get(link.sessionKey) ?? 0) > 1) {
        log.warn(
          `skipping ambiguous upstream links for ${link.sessionKey}: multiple agents adopt the same key`,
        );
        continue;
      }
      const catalogLinks = grouped.get(link.catalogId) ?? [];
      catalogLinks.push(link);
      grouped.set(link.catalogId, catalogLinks);
    }
  } catch (error) {
    log.warn(`failed to list watched session upstream links: ${String(error)}`);
  }
  return grouped;
}
