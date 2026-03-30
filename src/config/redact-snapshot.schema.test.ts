import { describe, expect, it } from "vitest";
import { REDACTED_SENTINEL, redactConfigSnapshot } from "./redact-snapshot.js";
import { makeSnapshot, restoreRedactedValues } from "./redact-snapshot.test-helpers.js";
import { redactSnapshotTestHints as mainSchemaHints } from "./redact-snapshot.test-hints.js";

describe("realredactConfigSnapshot_real", () => {
  it("main schema redact works (samples)", () => {
    const snapshot = makeSnapshot({
      agents: {
        defaults: {
          memorySearch: {
            remote: {
              apiKey: "1234",
            },
          },
        },
        list: [
          {
            memorySearch: {
              remote: {
                apiKey: "6789",
              },
            },
          },
        ],
      },
    });

    const result = redactConfigSnapshot(snapshot, mainSchemaHints);
    const config = result.config as typeof snapshot.config;
    expect(config.agents.defaults.memorySearch.remote.apiKey).toBe(REDACTED_SENTINEL);
    expect(config.agents.list[0].memorySearch.remote.apiKey).toBe(REDACTED_SENTINEL);
    const restored = restoreRedactedValues(result.config, snapshot.config, mainSchemaHints);
    expect(restored.agents.defaults.memorySearch.remote.apiKey).toBe("1234");
    expect(restored.agents.list[0].memorySearch.remote.apiKey).toBe("6789");
  });
});
