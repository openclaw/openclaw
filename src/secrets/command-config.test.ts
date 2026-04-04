import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectCommandSecretAssignmentsFromSnapshot } from "./command-config.js";

describe("collectCommandSecretAssignmentsFromSnapshot", () => {
  it("returns assignments from the active runtime snapshot for configured refs", () => {
    const sourceConfig = {
      talk: {
        providers: {
          elevenlabs: {
            apiKey: { source: "env", provider: "default", id: "TALK_API_KEY" },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const resolvedConfig = {
      talk: {
        providers: {
          elevenlabs: {
            apiKey: "talk-key", // pragma: allowlist secret
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = collectCommandSecretAssignmentsFromSnapshot({
      sourceConfig,
      resolvedConfig,
      commandName: "memory status",
      targetIds: new Set(["talk.providers.*.apiKey"]),
    });

    expect(result.assignments).toEqual([
      {
        path: "talk.providers.elevenlabs.apiKey",
        pathSegments: ["talk", "providers", "elevenlabs", "apiKey"],
        value: "talk-key",
      },
    ]);
  });

  it("throws when configured refs are unresolved in the snapshot", () => {
    const sourceConfig = {
      talk: {
        providers: {
          elevenlabs: {
            apiKey: { source: "env", provider: "default", id: "TALK_API_KEY" },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const resolvedConfig = {
      talk: {
        providers: {
          elevenlabs: {},
        },
      },
    } as unknown as OpenClawConfig;

    expect(() =>
      collectCommandSecretAssignmentsFromSnapshot({
        sourceConfig,
        resolvedConfig,
        commandName: "memory search",
        targetIds: new Set(["talk.providers.*.apiKey"]),
      }),
    ).toThrow(
      /memory search: talk\.providers\.elevenlabs\.apiKey is unresolved in the active runtime snapshot/,
    );
  });

  it("skips unresolved refs that are marked inactive by runtime warnings", () => {
    const sourceConfig = {
      agents: {
        defaults: {
          memorySearch: {
            remote: {
              apiKey: { source: "env", provider: "default", id: "DEFAULT_MEMORY_KEY" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const resolvedConfig = {
      agents: {
        defaults: {
          memorySearch: {
            remote: {
              apiKey: { source: "env", provider: "default", id: "DEFAULT_MEMORY_KEY" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = collectCommandSecretAssignmentsFromSnapshot({
      sourceConfig,
      resolvedConfig,
      commandName: "memory search",
      targetIds: new Set(["agents.defaults.memorySearch.remote.apiKey"]),
      inactiveRefPaths: new Set(["agents.defaults.memorySearch.remote.apiKey"]),
    });

    expect(result.assignments).toEqual([]);
    expect(result.diagnostics).toEqual([
      "agents.defaults.memorySearch.remote.apiKey: secret ref is configured on an inactive surface; skipping command-time assignment.",
    ]);
  });
});
