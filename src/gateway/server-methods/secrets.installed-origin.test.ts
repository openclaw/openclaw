/**
 * Whole-path proof for #104320: installed-origin plugin secret targets reach
 * gateway secrets.resolve validation before resolution.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const metadataMocks = vi.hoisted(() => ({
  resolvePluginMetadataSnapshot: vi.fn(() => ({ plugins: [] })),
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshot: metadataMocks.resolvePluginMetadataSnapshot,
}));

const EXA_TARGET_ID = "plugins.entries.exa.config.webSearch.apiKey";

const ISSUE_104320_RESOLVE_PARAMS = {
  commandName: "infer web search",
  targetIds: [EXA_TARGET_ID],
  allowedPaths: [EXA_TARGET_ID],
  forcedActivePaths: [EXA_TARGET_ID],
  providerOverrides: { webSearch: "exa" },
} as const;

function installedExaPluginRecord() {
  return {
    id: "exa",
    origin: "global",
    channels: [],
    contracts: { webSearchProviders: ["exa"] },
    configUiHints: { "webSearch.apiKey": { sensitive: true } },
    configContracts: {
      secretInputs: { paths: [{ path: "webSearch.apiKey" }] },
    },
  };
}

describe("secrets.resolve installed-origin plugin targets (#104320)", () => {
  beforeEach(() => {
    vi.resetModules();
    metadataMocks.resolvePluginMetadataSnapshot.mockClear();
    metadataMocks.resolvePluginMetadataSnapshot.mockReturnValue({
      plugins: [installedExaPluginRecord()],
    } as never);
  });

  it("accepts the issue's exa SecretRef target id and reaches resolveSecrets", async () => {
    const { createSecretsHandlers } = await import("./secrets.js");
    const resolveSecrets = vi.fn().mockResolvedValue({
      assignments: [
        {
          path: EXA_TARGET_ID,
          pathSegments: ["plugins", "entries", "exa", "config", "webSearch", "apiKey"],
          value: "[REDACTED]",
        },
      ],
      diagnostics: [],
      inactiveRefPaths: [],
    });
    const handlers = createSecretsHandlers({
      reloadSecrets: async () => ({ warningCount: 0 }),
      resolveSecrets,
    });
    const respond = vi.fn();

    await handlers["secrets.resolve"]({
      req: { type: "req", id: "proof-104320", method: "secrets.resolve" },
      params: ISSUE_104320_RESOLVE_PARAMS,
      client: null,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {} as never,
    });

    expect(resolveSecrets).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: ISSUE_104320_RESOLVE_PARAMS.commandName,
        targetIds: ISSUE_104320_RESOLVE_PARAMS.targetIds,
      }),
    );
    expect(respond.mock.calls.at(0)?.[0]).toBe(true);
  });
});
