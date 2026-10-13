import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";

/** Join worker ownership before clearing native test handles and failure latches. */
export async function closeStateDatabaseForTest(): Promise<void> {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}

/** Module resets can leave multiple database cohorts; preserve their cleanup order. */
export async function closeDatabaseTestCohorts(
  closers: Iterable<() => void | Promise<void>>,
): Promise<void> {
  for (const close of closers) {
    await close();
  }
}
