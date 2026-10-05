import { expect, it } from "vitest";
import { findSourceImportBackedges } from "../../../test/helpers/source-import-closure.js";

const readOwners = [
  "src/config/sessions/session-transcript.worker.ts",
  "src/config/sessions/session-accessor.sqlite-branches.ts",
  "src/gateway/session-history-readonly-reader.ts",
  "src/gateway/session-transcript-preview-reader.ts",
  "src/gateway/server-methods/chat-history-page-kernel.ts",
  "src/gateway/session-history-snapshot.ts",
];

it("keeps history readers independent of host acquisition and decoration", () => {
  expect(
    findSourceImportBackedges(readOwners, [
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

it("keeps lazy readers independent of unrelated runtime barrels", () => {
  expect(
    findSourceImportBackedges(
      [
        "src/gateway/session-history-worker-reader.ts",
        "src/config/sessions/session-store-target-inventory.ts",
        "src/config/sessions/session-entry-read.worker.ts",
        "src/config/sessions/session-accessor.sqlite-model-context.ts",
      ],
      [
        "src/config/sessions/lifecycle.ts",
        "src/config/sessions/session-accessor.ts",
        "src/config/sessions/session-accessor.sqlite-entry-store.ts",
        "src/config/sessions/session-accessor.sqlite-read.ts",
        "src/config/sessions/session-accessor.sqlite-exact-read.ts",
        "packages/ai/src/transports.ts",
      ],
    ),
  ).toEqual([]);
  expect(
    findSourceImportBackedges("src/infra/session-cost-usage-worker.ts", [
      "src/config/sessions/session-accessor.ts",
      "packages/ai/src/transports.ts",
    ]),
  ).toEqual([]);
});
