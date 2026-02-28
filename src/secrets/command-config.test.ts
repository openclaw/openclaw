import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectCommandSecretAssignmentsFromSnapshot } from "./command-config.js";

describe("collectCommandSecretAssignmentsFromSnapshot", () => {
  it("returns assignments from the active runtime snapshot for configured refs", () => {
    const sourceConfig = {
      talk: {
        apiKey: { source: "env", provider: "default", id: "TALK_API_KEY" },
      },
    } as OpenClawConfig;
    const resolvedConfig = {
      talk: {
        apiKey: "talk-key",
      },
    } as OpenClawConfig;

    const result = collectCommandSecretAssignmentsFromSnapshot({
      sourceConfig,
      resolvedConfig,
      commandName: "memory status",
      targetIds: new Set(["talk.apiKey"]),
    });

    expect(result.assignments).toEqual([
      {
        path: "talk.apiKey",
        pathSegments: ["talk", "apiKey"],
        value: "talk-key",
      },
    ]);
  });

  it("throws when configured refs are unresolved in the snapshot", () => {
    const sourceConfig = {
      talk: {
        apiKey: { source: "env", provider: "default", id: "TALK_API_KEY" },
      },
    } as OpenClawConfig;
    const resolvedConfig = {
      talk: {},
    } as OpenClawConfig;

    expect(() =>
      collectCommandSecretAssignmentsFromSnapshot({
        sourceConfig,
        resolvedConfig,
        commandName: "memory search",
        targetIds: new Set(["talk.apiKey"]),
      }),
    ).toThrow(/memory search: talk\.apiKey is unresolved in the active runtime snapshot/);
  });
});
