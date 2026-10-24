import type { SessionStoreWorkerReadScope } from "../config/sessions/session-entry-read-runtime.types.js";

export type PreparedSessionFactsSource = NonNullable<
  SessionStoreWorkerReadScope["preparedSource"]
> & {
  storePath: string;
  canonicalKey: string;
};
