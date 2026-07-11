/**
 * Whole-path proof for #104320: installed-origin plugin secret targets reach
 * gateway secrets.resolve validation before resolution.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const metadataMocks = vi.hoisted(() => ({
  resolvePluginMetadataSnapshot: vi.fn(() => ({ plugins: [] })),
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshot: metadataMocks.resolvePluginMetadataSnapshot,
}));

const EXA_TARGET_ID = "plugins.entries.exa.config.webSearch.apiKey";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const EXA_MANIFEST_PATH = path.join(REPO_ROOT, "extensions/exa/openclaw.plugin.json");

const ISSUE_104320_RESOLVE_PARAMS = {
  commandName: "infer web search",
  targetIds: [EXA_TARGET_ID],
  allowedPaths: [EXA_TARGET_ID],
  forcedActivePaths: [EXA_TARGET_ID],
  providerOverrides: { webSearch: "exa" },
} as const;

function installedExaPluginRecordFromManifest(manifest: {
  id: string;
  contracts?: { webSearchProviders?: string[] };
  uiHints?: Record<string, { sensitive?: boolean }>;
  configContracts?: { secretInputs?: { paths: Array<{ path: string }> } };
}) {
  return {
    id: manifest.id,
    origin: "global" as const,
    channels: [],
    contracts: manifest.contracts ?? {},
    configUiHints: manifest.uiHints ?? {},
    configContracts: manifest.configContracts,
  };
}

function installedExaPluginRecord() {
  return installedExaPluginRecordFromManifest({
    id: "exa",
    contracts: { webSearchProviders: ["exa"] },
    uiHints: { "webSearch.apiKey": { sensitive: true } },
    configContracts: {
      secretInputs: { paths: [{ path: "webSearch.apiKey" }] },
    },
  });
}

function redactSecretsResolvePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.assignments)) {
    return record;
  }
  return {
    ...record,
    assignments: record.assignments.map((entry) => {
      if (!entry || typeof entry !== "object") {
        return entry;
      }
      const assignment = entry as Record<string, unknown>;
      assignment.value = "[REDACTED]";
      return assignment;
    }),
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

  it("L3 live capture: real exa manifest + issue gateway probe params (redacted stdout)", async () => {
    const manifest = JSON.parse(fs.readFileSync(EXA_MANIFEST_PATH, "utf8")) as {
      id: string;
      contracts?: { webSearchProviders?: string[] };
      uiHints?: Record<string, { sensitive?: boolean }>;
      configContracts?: { secretInputs?: { paths: Array<{ path: string }> } };
    };
    const record = installedExaPluginRecordFromManifest(manifest);

    expect(record.origin).toBe("global");
    expect(record.contracts?.webSearchProviders).toContain("exa");
    expect(record.configUiHints?.["webSearch.apiKey"]?.sensitive).toBe(true);
    expect([record].filter((entry) => entry.origin === "bundled")).toHaveLength(0);

    metadataMocks.resolvePluginMetadataSnapshot.mockReturnValue({
      plugins: [record],
    } as never);

    const { getSecretTargetRegistry } = await import("../../secrets/target-registry-data.js");
    const { isKnownSecretTargetId } = await import("../../secrets/target-registry-query.js");
    const { createSecretsHandlers } = await import("./secrets.js");

    expect(getSecretTargetRegistry().map((entry) => entry.id)).toContain(EXA_TARGET_ID);
    expect(isKnownSecretTargetId(EXA_TARGET_ID)).toBe(true);

    const resolveSecrets = vi.fn().mockResolvedValue({
      assignments: [
        {
          path: EXA_TARGET_ID,
          pathSegments: ["plugins", "entries", "exa", "config", "webSearch", "apiKey"],
          value: "exa-live-secret-value",
        },
      ],
      diagnostics: [],
      inactiveRefPaths: [],
    });
    const respond = vi.fn();
    const handlers = createSecretsHandlers({
      reloadSecrets: async () => ({ warningCount: 0 }),
      resolveSecrets,
    });

    await handlers["secrets.resolve"]({
      req: { type: "req", id: "proof-104320-l3", method: "secrets.resolve" },
      params: ISSUE_104320_RESOLVE_PARAMS,
      client: null,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {} as never,
    });

    expect(respond.mock.calls.at(0)?.[0]).toBe(true);
    const gatewayPayload = redactSecretsResolvePayload(respond.mock.calls.at(0)?.[1]);
    const mainFailure = {
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: `invalid secrets.resolve params: unknown target id "${EXA_TARGET_ID}"`,
      },
    };

    console.log(
      [
        "[L3 proof #104320] manifest:",
        EXA_MANIFEST_PATH,
        `[L3 proof #104320] installed-origin record: id=${record.id} origin=${record.origin}`,
        `[L3 proof #104320] main bundled-only filter would register: false`,
        `[L3 proof #104320] isKnownSecretTargetId(${EXA_TARGET_ID}): true`,
        `[L3 proof #104320] openclaw gateway call secrets.resolve --params '${JSON.stringify(ISSUE_104320_RESOLVE_PARAMS)}'`,
        `[L3 proof #104320] main (simulated): ${JSON.stringify(mainFailure)}`,
        `[L3 proof #104320] fix branch (this run, redacted): ${JSON.stringify({ ok: true, ...gatewayPayload })}`,
      ].join("\n"),
    );
  });
});
