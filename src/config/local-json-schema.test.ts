import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readConfigFileSnapshotForWriteMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn(async () => {}));
const readBestEffortRuntimeConfigSchemaMock = vi.hoisted(() =>
  vi.fn(async () => ({
    schema: {
      type: "object",
      properties: {
        update: {
          type: "object",
          properties: {},
        },
      },
    },
    version: "9.9.9-test",
  })),
);

vi.mock("./config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config.js")>()),
  readConfigFileSnapshotForWrite: readConfigFileSnapshotForWriteMock,
  writeConfigFile: writeConfigFileMock,
}));

vi.mock("./runtime-schema.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-schema.js")>()),
  readBestEffortRuntimeConfigSchema: readBestEffortRuntimeConfigSchemaMock,
}));

const { maintainLocalConfigJsonSchemaArtifacts } = await import("./local-json-schema.js");

describe("maintainLocalConfigJsonSchemaArtifacts", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schema-maint-"));
    configPath = path.join(tempDir, "openclaw.json");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("does not rewrite invalid existing config snapshots", async () => {
    readConfigFileSnapshotForWriteMock.mockResolvedValueOnce({
      snapshot: {
        path: configPath,
        exists: true,
        raw: "{bad",
        parsed: {},
        resolved: {},
        valid: false,
        config: {},
        issues: [{ path: "", message: "invalid" }],
        warnings: [],
        legacyIssues: [],
      },
      writeOptions: {
        expectedConfigPath: configPath,
      },
    });

    await maintainLocalConfigJsonSchemaArtifacts();

    expect(writeConfigFileMock).not.toHaveBeenCalled();
    await expect(fs.access(path.join(tempDir, "openclaw_schema.json"))).rejects.toThrow();
  });

  it("avoids a second schema write when config write already handled sync", async () => {
    readConfigFileSnapshotForWriteMock.mockResolvedValueOnce({
      snapshot: {
        path: configPath,
        exists: true,
        raw: '{"gateway":{"mode":"local"}}',
        parsed: { gateway: { mode: "local" } },
        resolved: { gateway: { mode: "local" } },
        valid: true,
        config: { gateway: { mode: "local" } },
        issues: [],
        warnings: [],
        legacyIssues: [],
      },
      writeOptions: {
        expectedConfigPath: configPath,
      },
    });

    await maintainLocalConfigJsonSchemaArtifacts();

    expect(writeConfigFileMock).toHaveBeenCalledWith(
      {
        gateway: { mode: "local" },
        $schema: "openclaw_schema.json",
      },
      { expectedConfigPath: configPath },
    );
    await expect(fs.access(path.join(tempDir, "openclaw_schema.json"))).rejects.toThrow();
  });
});
