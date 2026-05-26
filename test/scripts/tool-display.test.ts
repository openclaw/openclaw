import { describe, expect, it } from "vitest";
import {
  collectToolDisplayConfigDuplicateKeys,
  collectToolDisplaySnapshotDuplicateKeys,
  formatDuplicateToolKeyError,
} from "../../scripts/tool-display.ts";

describe("tool-display duplicate metadata guard", () => {
  it("reports duplicate top-level tool ids in the source config", () => {
    const duplicates = collectToolDisplayConfigDuplicateKeys(`
      export const TOOL_DISPLAY_CONFIG = {
        version: 1,
        tools: {
          transcripts: {},
          web_search: {
            actions: {
              status: {},
            },
          },
          transcripts: {},
        },
      };
    `);

    expect(duplicates).toEqual([{ lines: [5, 11], name: "transcripts" }]);
  });

  it("ignores duplicate action ids under separate tool specs", () => {
    const duplicates = collectToolDisplayConfigDuplicateKeys(`
      export const TOOL_DISPLAY_CONFIG = {
        version: 1,
        tools: {
          browser: {
            actions: {
              status: {},
            },
          },
          transcripts: {
            actions: {
              status: {},
            },
          },
        },
      };
    `);

    expect(duplicates).toEqual([]);
  });

  it("reports duplicate top-level tool ids in the generated snapshot", () => {
    const duplicates = collectToolDisplaySnapshotDuplicateKeys(`{
      "version": 1,
      "tools": {
        "transcripts": {},
        "web_search": {},
        "transcripts": {}
      }
    }`);

    expect(duplicates).toEqual([{ lines: [4, 6], name: "transcripts" }]);
  });

  it("formats duplicate metadata errors with line numbers", () => {
    expect(
      formatDuplicateToolKeyError("src/agents/tool-display-config.ts", [
        { lines: [10, 20], name: "transcripts" },
      ]),
    ).toBe(
      "tool-display metadata has duplicate tool ids in src/agents/tool-display-config.ts: transcripts at lines 10, 20",
    );
  });
});
