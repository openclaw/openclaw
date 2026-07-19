import { describe, expect, it, vi } from "vitest";
import type { ReadConfigFileSnapshotWithPluginMetadataResult } from "../config/io.js";
import { verifyGatewayStartup } from "./startup-verify.js";

function validConfigRead(): ReadConfigFileSnapshotWithPluginMetadataResult {
  return {
    snapshot: {
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      sourceConfig: {},
      resolved: {},
      valid: true,
      runtimeConfig: {},
      config: {},
      issues: [],
      warnings: [],
      legacyIssues: [],
    },
  };
}

describe("verifyGatewayStartup", () => {
  it("opens schema/catalog surfaces read-only and returns stable machine output", async () => {
    const preflightDatabases = vi.fn(() => ({ incompatible: [], indeterminate: [] }));
    const loadModelCatalog = vi.fn(async () => ({ entries: [{ id: "one" }] }));

    const result = await verifyGatewayStartup({
      env: { OPENCLAW_STATE_DIR: "/tmp/state" },
      deps: {
        readConfig: async () => validConfigRead(),
        preflightDatabases,
        loadModelCatalog,
      },
    });

    expect(result).toEqual({
      ok: true,
      protocol: "openclaw.gateway.verify",
      protocolVersion: 1,
      checks: {
        config: "valid",
        databases: "read-only",
        providers: "initialized",
      },
      models: 1,
    });
    expect(loadModelCatalog).toHaveBeenCalledWith({ config: {}, readOnly: true });
  });

  it("fails closed when an existing database cannot be inspected", async () => {
    await expect(
      verifyGatewayStartup({
        env: {},
        deps: {
          readConfig: async () => validConfigRead(),
          preflightDatabases: () => ({
            incompatible: [],
            indeterminate: [{ kind: "state", path: "/tmp/state.sqlite", reason: "locked" }],
          }),
          loadModelCatalog: async () => ({ entries: [] }),
        },
      }),
    ).rejects.toThrow("could not be read: locked");
  });

  it("fails closed when candidate provider dependencies cannot initialize", async () => {
    await expect(
      verifyGatewayStartup({
        env: {},
        deps: {
          readConfig: async () => validConfigRead(),
          preflightDatabases: () => ({ incompatible: [], indeterminate: [] }),
          loadModelCatalog: async () => {
            throw new Error("candidate provider dependency missing");
          },
        },
      }),
    ).rejects.toThrow("candidate provider dependency missing");
  });
});
