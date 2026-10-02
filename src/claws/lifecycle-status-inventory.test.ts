import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CLAW_CRON_REF_SCHEMA_VERSION } from "./cron.js";
import { digestClawValue } from "./digest.js";
import type { ClawInventory } from "./inventory-read.kernel.js";
import { readClawStatus } from "./lifecycle-status.js";
import { digestClawMcpServer, CLAW_MCP_REF_SCHEMA_VERSION } from "./mcp.js";
import { normalizeWorkspaceConfig, resolveMigrationAgentSettings } from "./migrate-validation.js";
import { CLAW_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION } from "./provenance-agent-origin.js";
import { CLAW_INSTALL_RECORD_SCHEMA_VERSION } from "./provenance-schema-version.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("compares inventory MCP refs against authored source values", async () => {
  const workspace = tempDirs.make("claw-status-inventory-");
  const sourceServer = { command: "docs-mcp", env: { DOCS_TOKEN: "${DOCS_TOKEN}" } };
  const runtimeServer = { command: "docs-mcp", env: { DOCS_TOKEN: "resolved-secret" } };
  const inventory: ClawInventory = {
    installs: [
      {
        schemaVersion: CLAW_INSTALL_RECORD_SCHEMA_VERSION,
        claw: {
          kind: "package",
          name: "@openclaw/docs",
          version: "1.0.0",
          packageRoot: workspace,
          manifestPath: `${workspace}/CLAW.md`,
          integrityKind: "artifact",
          integrity: "sha256:fixture",
          byteLength: 1,
        },
        manifestSchemaVersion: 1,
        planIntegrity: "sha256:plan",
        agentId: "docs",
        agentOrigin: "created",
        workspace,
        agentConfigDigest: "sha256:config",
        agentOwnedPaths: [],
        status: "complete",
        addedAtMs: 1,
        updatedAtMs: 1,
      },
    ],
    packages: [],
    workspaceFiles: [],
    mcpServers: [
      {
        schemaVersion: CLAW_MCP_REF_SCHEMA_VERSION,
        agentId: "docs",
        name: "docs",
        configDigest: digestClawMcpServer(sourceServer),
        relationship: "managed",
        origin: "claw-introduced",
        independentOwner: false,
        status: "complete",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    ],
    cronJobs: [],
  };
  const config = { mcp: { servers: { docs: runtimeServer } } };

  const sourceStatus = await readClawStatus("docs", {
    inventory,
    config,
    sourceMcpServers: { docs: sourceServer },
    readOnly: true,
  });
  const runtimeStatus = await readClawStatus("docs", { inventory, config, readOnly: true });

  expect(sourceStatus.records[0]?.mcpServers[0]?.state).toBe("present");
  expect(runtimeStatus.records[0]?.mcpServers[0]?.state).toBe("modified");
});

it("reads an older adopted full digest while keeping its legacy drift behavior", async () => {
  const workspace = tempDirs.make("claw-adopted-legacy-status-");
  const config: OpenClawConfig = {
    agents: {
      defaults: { model: "provider/original" },
      entries: { worker: { workspace } },
    },
  };
  const effective = normalizeWorkspaceConfig(
    resolveMigrationAgentSettings(config, { id: "worker", workspace }),
    workspace,
  );
  const inventory: ClawInventory = {
    installs: [
      {
        schemaVersion: CLAW_INSTALL_RECORD_ADOPTED_SCHEMA_VERSION,
        claw: {
          kind: "package",
          name: "@openclaw/worker",
          version: "1.0.0",
          packageRoot: workspace,
          manifestPath: `${workspace}/CLAW.md`,
          integrityKind: "artifact",
          integrity: "sha256:fixture",
          byteLength: 1,
        },
        manifestSchemaVersion: 1,
        planIntegrity: "sha256:plan",
        agentId: "worker",
        agentOrigin: "adopted",
        workspace,
        agentConfigDigest: digestClawValue(effective),
        agentOwnedPaths: [],
        status: "complete",
        addedAtMs: 1,
        updatedAtMs: 1,
      },
    ],
    packages: [],
    workspaceFiles: [],
    mcpServers: [],
    cronJobs: [],
  };

  const unchanged = await readClawStatus("worker", {
    inventory,
    config,
    sourceMcpServers: {},
    readOnly: true,
  });
  expect(unchanged.records[0]?.agentState).toBe("present");

  const changed = await readClawStatus("worker", {
    inventory,
    config: {
      ...config,
      agents: { ...config.agents, defaults: { model: "provider/changed" } },
    },
    sourceMcpServers: {},
    readOnly: true,
  });
  expect(changed.records[0]?.agentState).toBe("modified");
});

it("keeps orphaned MCP and cron refs visible when their install row is missing", async () => {
  const inventory: ClawInventory = {
    installs: [],
    packages: [],
    workspaceFiles: [],
    mcpServers: [
      {
        schemaVersion: CLAW_MCP_REF_SCHEMA_VERSION,
        agentId: "orphan-mcp",
        name: "docs",
        configDigest: "sha256:missing",
        relationship: "managed",
        origin: "claw-introduced",
        independentOwner: false,
        status: "pending",
        createdAtMs: 1,
        updatedAtMs: 2,
      },
    ],
    cronJobs: [
      {
        schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
        agentId: "orphan-cron",
        manifestId: "daily",
        declarationKey: "claw:orphan-cron:daily",
        schedulerJobId: "scheduler-daily",
        status: "complete",
        job: {
          id: "daily",
          schedule: { cron: "0 9 * * *", timezone: "UTC" },
          session: "main",
          message: "Prepare the report",
        },
        createdAtMs: 1,
        updatedAtMs: 3,
      },
    ],
  };

  const status = await readClawStatus(undefined, {
    inventory,
    config: {},
    sourceMcpServers: {},
    readOnly: true,
  });

  expect(status.records).toEqual([
    expect.objectContaining({
      orphaned: true,
      install: expect.objectContaining({ agentId: "orphan-mcp", updatedAtMs: 2 }),
      mcpServers: [expect.objectContaining({ name: "docs", state: "pending" })],
    }),
    expect.objectContaining({
      orphaned: true,
      install: expect.objectContaining({ agentId: "orphan-cron", updatedAtMs: 3 }),
      cronJobs: [expect.objectContaining({ schedulerJobId: "scheduler-daily" })],
    }),
  ]);
});
