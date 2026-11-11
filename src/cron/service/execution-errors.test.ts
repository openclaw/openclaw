import { expect, it } from "vitest";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";

it.each([false, true])(
  "renders uncertain cron writes with the shared recovery guidance (sibling: %s)",
  (sibling) => {
    const unknown = new SqliteWorkerError("PRIVATE_DATABASE_DETAIL", "outcome-unknown");
    const primary = sibling ? new Error("PRIVATE_PUBLICATION_DETAIL") : unknown;
    const error = new AggregateError(
      [primary, sibling ? unknown : new Error("PRIVATE_CLEANUP_DETAIL")],
      "PRIVATE_AGGREGATE",
      {
        cause: primary,
      },
    );
    const text = normalizeCronRunErrorText(error);
    expect(text).toMatch(/confirm|saved/i);
    expect(text).toMatch(/check|reopen|retry/i);
    expect(text).not.toContain("PRIVATE_");
  },
);
