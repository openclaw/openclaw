import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  flushDiagnosticsTimeline,
  measureDiagnosticsTimelineSpan,
} from "../infra/diagnostics-timeline.js";
import { clearSecretsRuntimeSnapshotState } from "../secrets/runtime-state.js";
import { captureEnv } from "../test-utils/env.js";
import { prepareGatewayStartupConfig } from "./server-startup-config-helpers.js";
import { createTestRuntimeSecretsActivator } from "./server-startup-config.test-support.js";
import { buildTestConfigSnapshot } from "./test-helpers.config-snapshots.js";

const autoCleanupTempDirs = useAutoCleanupTempDirTracker(afterEach);

function gatewaySecretRefSnapshot() {
  const config: OpenClawConfig = {
    secrets: { providers: { default: { source: "env" } } },
    gateway: {
      auth: {
        mode: "token",
        token: { source: "env", provider: "default", id: "GATEWAY_TOKEN_REF" },
      },
    },
  };
  return buildTestConfigSnapshot({
    path: "/tmp/openclaw-startup-secrets-test.json",
    exists: true,
    raw: `${JSON.stringify(config, null, 2)}\n`,
    parsed: config,
    valid: true,
    config,
    issues: [],
    legacyIssues: [],
  });
}

function readTimelineEvents(filePath: string): Array<Record<string, unknown>> {
  flushDiagnosticsTimeline();
  return readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function installDiagnosticsTimelineEnv() {
  const root = autoCleanupTempDirs.make("openclaw-startup-secrets-timeline-");
  const timelinePath = path.join(root, "timeline.jsonl");
  const env = captureEnv(["OPENCLAW_DIAGNOSTICS", "OPENCLAW_DIAGNOSTICS_TIMELINE_PATH"]);
  process.env.OPENCLAW_DIAGNOSTICS = "timeline";
  process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = timelinePath;
  return {
    timelinePath,
    cleanup: () => {
      flushDiagnosticsTimeline();
      env.restore();
    },
  };
}

afterEach(clearSecretsRuntimeSnapshotState);

it("omits secret preparation error messages from diagnostics timeline spans", async () => {
  const timelineEnv = installDiagnosticsTimelineEnv();
  try {
    const failure = new Error('Secret provider "default" is not configured for GATEWAY_TOKEN_REF.');
    const activate = createTestRuntimeSecretsActivator(async () => {
      throw failure;
    });

    await expect(
      prepareGatewayStartupConfig({
        configSnapshot: gatewaySecretRefSnapshot(),
        activateRuntimeSecrets: activate,
        measure: (name, run, options) =>
          measureDiagnosticsTimelineSpan(name, run, {
            env: process.env,
            omitErrorMessage: options?.omitErrorMessage,
            phase: "startup",
          }),
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining(failure.message), cause: failure });

    const events = readTimelineEvents(timelineEnv.timelinePath);
    expect(events.find((event) => event.name === "secrets.prepare")?.attributes).toEqual({
      activate: false,
      captureId: expect.any(String),
      sequence: expect.any(Number),
      failedWrites: 0,
      gatewayAuthSecretRef: true,
      reason: "startup",
    });
    const errorEvents = events.filter((event) => event.type === "span.error");
    expect(errorEvents.map((event) => event.name)).toEqual([
      "secrets.prepare",
      "config.auth.secret-preflight",
    ]);
    for (const event of errorEvents) {
      expect(event).toMatchObject({ phase: "startup", errorName: "Error" });
      expect(event.errorMessage).toBeUndefined();
    }
    expect(JSON.stringify(events)).not.toContain("GATEWAY_TOKEN_REF");
    expect(JSON.stringify(events)).not.toContain("default");
  } finally {
    timelineEnv.cleanup();
  }
});
