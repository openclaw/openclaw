import { expect, it } from "vitest";
import { findSourceImportBackedges } from "../../../test/helpers/source-import-closure.js";

const readOwners = [
  "src/config/sessions/session-transcript.worker.ts",
  "src/config/sessions/session-accessor.sqlite-entry-read.ts",
  "src/gateway/session-history-readonly-reader.ts",
  "src/gateway/session-transcript-preview-reader.ts",
  "src/state/openclaw-agent-db-readonly-scope.ts",
  "src/config/sessions/session-canonical-key.ts",
  "src/gateway/session-transcript-read-kernel.ts",
  "src/gateway/server-methods/chat-history-page-kernel.ts",
  "src/gateway/session-history-snapshot.ts",
  "src/gateway/session-history-tail.ts",
  "src/config/sessions/session-accessor.sqlite-projection-read.ts",
  "src/config/sessions/session-accessor.sqlite-history-query.ts",
  "src/config/sessions/session-accessor.sqlite-raw-delta-read.ts",
  "src/config/sessions/session-transcript-read-fence.ts",
  "src/gateway/session-transcript-archive-reader.ts",
  "src/gateway/session-transcript-entry-message.ts",
];

it.each(readOwners)("keeps %s independent of host acquisition and decoration", (entry) => {
  expect(
    findSourceImportBackedges(entry, [
      "src/config/sessions/session-accessor.sqlite-scope.ts",
      "src/config/sessions/session-accessor.sqlite-active-projection.ts",
      "src/config/sessions/session-accessor.sqlite-delta.ts",
      "src/config/sessions/session-accessor.sqlite-history-events.ts",
      "src/config/sessions/session-transcript-reconcile.ts",
      "src/state/openclaw-agent-db.ts",
      "src/state/openclaw-agent-db-lifecycle.ts",
      "src/state/openclaw-agent-db-readonly.ts",
      "src/state/openclaw-state-db.ts",
      "src/gateway/current-user-profile-display.ts",
      "src/gateway/session-transcript-message.ts",
      "src/gateway/session-utils.fs.ts",
    ]),
  ).toEqual([]);
});
