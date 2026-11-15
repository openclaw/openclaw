import { expect, it } from "vitest";
import {
  CODE_MODE_STORE_CUSTOM_TYPE,
  collectCodeModeStoreWrites,
} from "../../agents/code-mode-session-store-replay.js";
import { TranscriptReportNavigation } from "./session-transcript-report-policy.js";

it("folds each historical store snapshot before reading the next payload", () => {
  const navigation = new TranscriptReportNavigation(
    Array.from({ length: 3 }, (_, seq) => ({
      seq,
      facts: {
        kind: "canonical" as const,
        hasParentId: true,
        entry: {
          type: "custom" as const,
          id: `store-${seq}`,
          parentId: seq ? `store-${seq - 1}` : null,
        },
      },
    })),
  );
  let read = 0;
  let folded = 0;
  const entries = navigation.readCustomBranch("store-2", CODE_MODE_STORE_CUSTOM_TYPE, (seq) => {
    // Eagerly retaining all decoded snapshots can exhaust a long session's worker.
    expect(folded).toBe(read);
    read++;
    return {
      type: "custom",
      customType: CODE_MODE_STORE_CUSTOM_TYPE,
      get data() {
        folded = read;
        return { set: { key: seq }, delete: [], networkContent: { key: true } };
      },
    };
  });
  expect(entries).toBeDefined();
  expect(collectCodeModeStoreWrites(entries!)).toEqual(
    new Map([["key", { value: 2, networkContent: true }]]),
  );
  expect(read).toBe(3);
  expect(folded).toBe(3);
});
