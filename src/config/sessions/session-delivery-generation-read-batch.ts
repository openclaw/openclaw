import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type { retainPreparedSessionGenerationFacts } from "./session-accessor.sqlite-entry-cache.js";
import { withSessionEntriesFromStoresInWorker } from "./session-entry-read-runtime.js";
import type {
  PreparedSessionEntryWorkerRead,
  SessionEntryWorkerRead,
} from "./session-entry-read-runtime.types.js";

type RetainedGeneration = ReturnType<typeof retainPreparedSessionGenerationFacts> | undefined;
export type GenerationRead = (
  inputs: readonly (SessionEntryWorkerRead & { sessionKeys: readonly string[] })[],
  consume: (reads: readonly PreparedSessionEntryWorkerRead[]) => RetainedGeneration,
) => Promise<RetainedGeneration>;

/** Collect only the initial reads; existing lease consumers keep their individual authority. */
export function createSessionGenerationReadBatch() {
  type Pending = {
    input: Parameters<GenerationRead>[0][number];
    consume: Parameters<GenerationRead>[1];
    resolve: (value: RetainedGeneration) => void;
    reject: (error: unknown) => void;
  };
  const pending: Pending[] = [];
  const read: GenerationRead = ([input], consume) =>
    new Promise((resolve, reject) => {
      pending.push({ input: input!, consume, resolve, reject });
    });
  const flush = async () => {
    const groups: Pending[][] = [];
    for (const item of pending) {
      const group = groups.find(
        ([first]) =>
          first &&
          first.input.agentId === item.input.agentId &&
          first.input.storePath === item.input.storePath &&
          first.input.env === item.input.env,
      );
      if (group) {
        group.push(item);
      } else {
        groups.push([item]);
      }
    }
    await Promise.all(
      groups.map(async (group) => {
        const first = group[0]!;
        let consumed = false;
        try {
          const results = await withSessionEntriesFromStoresInWorker(
            [
              {
                ...first.input,
                sessionKeys: [...new Set(group.flatMap(({ input }) => input.sessionKeys))],
                projection: "sharing",
                includeAuthorization: true,
              },
            ],
            (reads) => {
              consumed = true;
              return group.map(({ consume }): Result<RetainedGeneration, unknown> => {
                try {
                  return ok(consume(reads));
                } catch (error) {
                  return err(error);
                }
              });
            },
          );
          for (const [index, result] of results.entries()) {
            const item = group[index]!;
            if (result.ok) {
              item.resolve(result.value);
            } else {
              item.reject(result.error);
            }
          }
        } catch (error) {
          // An unreadable row cannot suppress healthy siblings; never replay an installed lease.
          await Promise.all(
            group.map(async (item) => {
              if (consumed || group.length === 1) {
                item.reject(error);
                return;
              }
              await withSessionEntriesFromStoresInWorker([item.input], item.consume).then(
                item.resolve,
                item.reject,
              );
            }),
          );
        }
      }),
    );
  };
  return { read, flush };
}
