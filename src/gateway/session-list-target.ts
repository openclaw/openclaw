import type { materializeSessionRow } from "./session-utils-row.js";

/** Selection and search consume the prepared model facts of a resident row. */
export type SessionListTargetLookup = (key: string) =>
  | {
      agentId: string;
      storeKey?: string;
      materialized: Pick<ReturnType<typeof materializeSessionRow>, "source">;
    }
  | undefined;
