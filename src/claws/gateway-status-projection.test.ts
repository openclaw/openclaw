import { describe, expect, it } from "vitest";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import type { CronJob } from "../cron/types.js";
import {
  CLAW_CRON_REF_SCHEMA_VERSION,
  clawCronGatewayInput,
  type PersistedClawCronRef,
} from "./cron.js";
import { projectClawsStatus } from "./gateway-status-projection.js";
import type { ClawPackageStatus, ClawStatusRecord } from "./lifecycle-status.js";
import { CLAW_PACKAGE_REF_SCHEMA_VERSION } from "./package-extension-provenance.js";
import { CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION } from "./workspace.js";

function packageStatus(overrides: Partial<ClawPackageStatus> = {}): ClawPackageStatus {
  return {
    schemaVersion: CLAW_PACKAGE_REF_SCHEMA_VERSION,
    agentId: "workflow-operator",
    clawName: "@openclaw/workflow-operator",
    kind: "plugin",
    source: "clawhub",
    ref: "@openclaw/lobster",
    version: "2026.7.1",
    integrity: "sha256:test",
    status: "complete",
    relationship: "referenced",
    origin: "claw-introduced",
    independentOwner: false,
    installedAtMs: 1,
    updatedAtMs: 2,
    state: "present",
    ...overrides,
  };
}

function statusRecord(overrides: Partial<ClawStatusRecord> = {}): ClawStatusRecord {
  return {
    install: {
      agentId: "workflow-operator",
      claw: { kind: "package", name: "@openclaw/workflow-operator", version: "0.1.0" },
      status: "complete",
      addedAtMs: 1,
      updatedAtMs: 2,
    },
    agentState: "present",
    bootstrapState: "complete",
    workspaceFiles: [],
    packages: [],
    mcpServers: [],
    cronJobs: [],
    ...overrides,
  } as ClawStatusRecord;
}

describe("Gateway Claw status projection", () => {
  it("reports adopted agent ownership without guessing workspace file origins", () => {
    const created = statusRecord();
    const result = projectClawsStatus([
      statusRecord({
        install: { ...created.install, agentOrigin: "adopted" },
        workspaceFiles: [
          {
            schemaVersion: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
            agentId: "workflow-operator",
            workspace: "/tmp/workflow-operator",
            path: "SOUL.md",
            sourcePath: "SOUL.md",
            contentDigest: "sha256:existing",
            status: "complete",
            state: "unchanged",
            createdAtMs: 1,
            updatedAtMs: 2,
          },
          {
            schemaVersion: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
            agentId: "workflow-operator",
            workspace: "/tmp/workflow-operator",
            path: "NEW.md",
            sourcePath: "NEW.md",
            contentDigest: "sha256:added-on-update",
            status: "complete",
            state: "unchanged",
            createdAtMs: 3,
            updatedAtMs: 3,
          },
        ],
        packages: [packageStatus()],
      }),
    ]);

    expect(result.records[0]?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "agent",
          origin: "pre-existing",
          independentOwner: true,
        }),
        expect.objectContaining({
          kind: "plugin",
          origin: "claw-introduced",
          independentOwner: false,
        }),
      ]),
    );
    expect(
      result.records[0]?.resources.filter((resource) => resource.kind === "workspace-file"),
    ).toEqual([
      { kind: "workspace-file", id: "SOUL.md", state: "unchanged", relationship: "managed" },
      { kind: "workspace-file", id: "NEW.md", state: "unchanged", relationship: "managed" },
    ]);
  });

  it("does not hide extension drift or unresolved scheduled jobs", () => {
    const result = projectClawsStatus([
      statusRecord({
        packages: [
          packageStatus({
            relationship: "referenced",
            origin: "claw-introduced",
            independentOwner: false,
            extensionCompatibility: { state: "drifted", mapped: [], unavailable: [] },
          }),
        ],
        cronJobs: [
          { schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION, manifestId: "daily", status: "complete" },
        ] as ClawStatusRecord["cronJobs"],
      }),
    ]);

    expect(result.summary).toMatchObject({ claws: 1, healthy: 0, attention: 1 });
    expect(result.records[0]?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "plugin", state: "drifted", reason: expect.any(String) }),
        expect.objectContaining({
          kind: "cron-job",
          state: "unresolved",
          reason: expect.any(String),
        }),
      ]),
    );
  });

  it("keeps a complete unchanged Claw healthy", () => {
    expect(projectClawsStatus([statusRecord({})]).summary).toMatchObject({
      healthy: 1,
      attention: 0,
    });
  });

  it("checks complete cron refs against the live scheduler before marking them healthy", () => {
    const cron = {
      schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
      agentId: "workflow-operator",
      manifestId: "daily",
      declarationKey: "claw:workflow-operator:daily",
      schedulerJobId: "scheduler-daily",
      status: "complete",
      job: {
        id: "daily",
        schedule: { cron: "0 9 * * *" },
        session: "main",
        message: "Prepare the report",
      },
    } as PersistedClawCronRef;
    const normalized = normalizeCronJobCreate(clawCronGatewayInput("workflow-operator", cron));
    if (!normalized) {
      throw new Error("Expected valid Claw cron job");
    }
    const live = {
      ...normalized,
      id: "scheduler-daily",
      createdAtMs: 1,
      updatedAtMs: 1,
      state: { nextRunAtMs: 100 },
    } as CronJob;
    const record = statusRecord({ cronJobs: [cron] });

    expect(projectClawsStatus([record], [live]).summary.healthy).toBe(1);
    expect(projectClawsStatus([record], []).records[0]?.resources).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "cron-job", state: "missing" })]),
    );
    expect(
      projectClawsStatus([record], [{ ...live, enabled: false }]).records[0]?.resources,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "cron-job", state: "modified" })]),
    );
    expect(projectClawsStatus([record]).records[0]?.resources).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "cron-job", state: "unresolved" })]),
    );
  });

  it("does not expose package inspection or scheduler errors in read-scoped status", () => {
    const result = projectClawsStatus([
      statusRecord({
        packages: [
          packageStatus({
            message: "secret-token from package",
            extensionCompatibility: {
              state: "unavailable",
              mapped: [],
              unavailable: [],
              message: "secret-token from extension",
            },
          }),
          packageStatus({
            kind: "skill",
            ref: "@openclaw/example",
            version: "1.0.0",
            state: "missing",
            message: "secret-token from skill",
          }),
        ],
        cronJobs: [
          {
            schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
            manifestId: "daily",
            status: "failed",
            error: "secret-token from scheduler",
          },
        ] as ClawStatusRecord["cronJobs"],
      }),
    ]);

    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(result.records[0]?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "plugin",
          reason: "Extension compatibility is unavailable.",
        }),
        expect.objectContaining({ kind: "skill", reason: "The installed package is missing." }),
        expect.objectContaining({ kind: "cron-job", reason: "Scheduled job setup failed." }),
      ]),
    );
  });
});
