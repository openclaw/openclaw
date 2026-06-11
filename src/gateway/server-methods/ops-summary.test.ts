import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../../cron/types.js";
import { __testing as agentsTesting } from "./agents.js";
import { opsSummaryHandlers } from "./ops-summary.js";
import type { GatewayRequestContext } from "./types.js";

const tempDirs: string[] = [];

afterEach(() => {
  agentsTesting.resetDepsForTests();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function cronJob(patch: Partial<CronJob>): CronJob {
  return {
    id: "job-1",
    name: "Kalshi status bridge",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 2,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "check status" },
    state: {},
    ...patch,
  } as CronJob;
}

function installRuntimeMocks(params?: { loadedModelBytes?: number; processRssKb?: number }) {
  const loadedModelBytes = params?.loadedModelBytes ?? 4_800_000_000;
  const processRssKb = params?.processRssKb ?? 512_000;
  agentsTesting.setDepsForTests({
    fetchFn: vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                name: "qwen25-32b:latest",
                model: "qwen25-32b:latest",
                size: loadedModelBytes,
                size_vram: 0,
                context_length: 32768,
                processor: "cpu",
                details: { parameter_size: "32B", quantization_level: "Q4_K_M" },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as typeof fetch,
    execFileFn: vi.fn(async (file, args) => {
      if (file === "vm_stat") {
        return {
          stdout: [
            "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
            "Pages free:                               1000.",
            "Pages speculative:                         200.",
            "Pages purgeable:                            50.",
            "File-backed pages:                         300.",
          ].join("\n"),
          stderr: "",
        };
      }
      return {
        stdout: String(args?.join(" ")).includes("command=")
          ? [
              `101 ${processRssKb} /opt/homebrew/bin/ollama`,
              "202 262144 /opt/homebrew/opt/node/bin/node /Users/openclaw/openclaw/dist/entry.js gateway",
            ].join("\n")
          : `${processRssKb} /opt/homebrew/bin/ollama\n`,
        stderr: "",
      };
    }),
  });
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function createCustomizationFixture(params?: { mutateAfterManifest?: boolean }) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-ops-customization-"));
  tempDirs.push(root);
  const init = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
  if (init.status !== 0) {
    throw new Error(init.stderr || "failed to initialize customization fixture git repository");
  }
  const customFile = path.join(root, "ui", "src", "custom-dashboard.ts");
  mkdirSync(path.dirname(customFile), { recursive: true });
  writeFileSync(customFile, "export const customDashboard = true;\n", "utf8");
  const patchDir = path.join(root, "customizations", "dashboard");
  mkdirSync(patchDir, { recursive: true });
  const patch = spawnSync(
    "git",
    ["diff", "--binary", "--no-index", "--", "/dev/null", "ui/src/custom-dashboard.ts"],
    { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  if (patch.status !== 1 || !patch.stdout) {
    throw new Error(patch.stderr || "failed to create customization patch");
  }
  const patchPath = path.join(patchDir, "openclaw-dashboard-customizations.patch");
  writeFileSync(patchPath, patch.stdout, "utf8");
  const manifestPath = path.join(patchDir, "manifest.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        name: "OpenClaw Dashboard Customizations",
        generatedAtUtc: "2026-05-17T18:28:14.911Z",
        patch: "customizations/dashboard/openclaw-dashboard-customizations.patch",
        fileCount: 1,
        files: [
          {
            path: "ui/src/custom-dashboard.ts",
            tracked: false,
            bytes: readFileSync(customFile).byteLength,
            sha256: sha256(customFile),
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  if (params?.mutateAfterManifest) {
    writeFileSync(customFile, "export const customDashboard = false;\n", "utf8");
  }
  return root;
}

async function callOpsSummary(contextPatch: Partial<GatewayRequestContext>) {
  const respond = vi.fn();
  await opsSummaryHandlers["ops.summary"]({
    params: {},
    respond,
    context: contextPatch as GatewayRequestContext,
    req: { type: "req", id: "1", method: "ops.summary" },
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("ops.summary", () => {
  it("reports failed cron jobs as gateway-owned issues", async () => {
    installRuntimeMocks();
    const failedJob = cronJob({
      id: "kalshi-status",
      state: {
        nextRunAtMs: 1_900_000_000_000,
        lastRunAtMs: 1_899_999_000_000,
        lastRunStatus: "error",
        lastError: "cron: job interrupted by gateway restart",
        consecutiveErrors: 1,
      },
    });
    const respond = await callOpsSummary({
      cron: {
        status: vi.fn(async () => ({ enabled: true })),
        list: vi.fn(async () => [failedJob]),
      },
      getRuntimeSnapshot: () => ({
        channels: {},
        channelAccounts: {},
      }),
    } as unknown as Partial<GatewayRequestContext>);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        state: "needs_review",
        checks: expect.objectContaining({
          cronEnabled: true,
          cronJobs: 1,
          failedCronJobs: 1,
          loadedModelCount: 1,
        }),
        issues: [
          expect.objectContaining({
            id: "cron-kalshi-status",
            severity: "medium",
            title: "Scheduled job failed",
            likelyCause: "cron: job interrupted by gateway restart",
            nextInspection: "cron.runs for kalshi-status",
          }),
        ],
      }),
    );
  });

  it("does not report disabled cron failures as active ops issues", async () => {
    installRuntimeMocks({ loadedModelBytes: 0, processRssKb: 0 });
    const disabledFailedJob = cronJob({
      id: "disabled-real-estate",
      name: "Daily Real Estate Evaluations",
      enabled: false,
      state: {
        lastRunAtMs: 1_899_999_000_000,
        lastRunStatus: "error",
        lastStatus: "error",
        lastError: "previous disabled run failed",
        consecutiveErrors: 1,
      },
    });
    const respond = await callOpsSummary({
      cron: {
        status: vi.fn(async () => ({ enabled: true })),
        list: vi.fn(async () => [disabledFailedJob]),
      },
      getRuntimeSnapshot: () => ({
        channels: {},
        channelAccounts: {},
      }),
    } as unknown as Partial<GatewayRequestContext>);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        state: "watching",
        checks: expect.objectContaining({
          cronJobs: 1,
          failedCronJobs: 0,
        }),
        issues: [],
      }),
    );
  });

  it("includes channel and model telemetry in the verified checks", async () => {
    installRuntimeMocks({ loadedModelBytes: 29_000_000_000, processRssKb: 30_000_000 });
    const respond = await callOpsSummary({
      cron: {
        status: vi.fn(async () => ({ enabled: true })),
        list: vi.fn(async () => [
          cronJob({ state: { nextRunAtMs: 1_900_000_000_000, lastRunStatus: "ok" } }),
        ]),
      },
      getRuntimeSnapshot: () => ({
        channels: {},
        channelAccounts: {
          discord: {
            default: {
              accountId: "default",
              configured: true,
              enabled: true,
              running: true,
              connected: true,
            },
          },
        },
      }),
    } as unknown as Partial<GatewayRequestContext>);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        state: "watching",
        checks: expect.objectContaining({
          channelAccounts: 1,
          loadedModelBytes: 29_000_000_000,
          ollamaProcessRssBytes: 30_000_000 * 1024,
          nextCronRunAtMs: 1_900_000_000_000,
        }),
        sources: expect.objectContaining({
          runtimeTelemetry: "live",
          cron: "live",
          channels: "live",
        }),
      }),
    );
  });

  it("describes Discord gateway disconnects with user-actionable details", async () => {
    installRuntimeMocks();
    const disconnectAt = Date.parse("2026-05-08T19:24:00.000Z");
    const respond = await callOpsSummary({
      cron: {
        status: vi.fn(async () => ({ enabled: true })),
        list: vi.fn(async () => [
          cronJob({ state: { nextRunAtMs: 1_900_000_000_000, lastRunStatus: "ok" } }),
        ]),
      },
      getRuntimeSnapshot: () => ({
        channels: {},
        channelAccounts: {
          discord: {
            default: {
              accountId: "default",
              configured: true,
              enabled: true,
              running: true,
              connected: false,
              lastDisconnect: { at: disconnectAt, status: 4000 },
            },
          },
        },
      }),
    } as unknown as Partial<GatewayRequestContext>);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        state: "needs_review",
        issues: [
          expect.objectContaining({
            id: "channel-discord-default",
            severity: "medium",
            title: "Discord is having trouble connecting",
            affected: "discord: default",
            detectedAt: disconnectAt,
            likelyCause: "gateway close code 4000",
            plainSummary:
              "Discord is reachable in config, but the live Discord connection is degraded.",
            whyItMatters: expect.stringContaining("Messages from Discord may not reach OpenClaw"),
            recommendedAction: expect.stringContaining("Open Channels"),
          }),
        ],
      }),
    );
  });

  it("treats large loaded model notices as watching instead of needing review", async () => {
    installRuntimeMocks({ loadedModelBytes: 34 * 1024 ** 3, processRssKb: 35_000_000 });
    const respond = await callOpsSummary({
      cron: {
        status: vi.fn(async () => ({ enabled: true })),
        list: vi.fn(async () => [
          cronJob({ state: { nextRunAtMs: 1_900_000_000_000, lastRunStatus: "ok" } }),
        ]),
      },
      getRuntimeSnapshot: () => ({
        channels: {},
        channelAccounts: {},
      }),
    } as unknown as Partial<GatewayRequestContext>);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        state: "watching",
        issues: [
          expect.objectContaining({
            severity: "low",
            title: "Runtime telemetry warning",
            likelyCause: expect.stringContaining("is using 34 GB"),
          }),
        ],
      }),
    );
  });

  it("reports healthy dashboard customization protection when the bundle is current", async () => {
    installRuntimeMocks({ loadedModelBytes: 0, processRssKb: 0 });
    const sourceRoot = createCustomizationFixture();
    const respond = await callOpsSummary({
      getRuntimeConfig: () => ({
        update: {
          preserveDirty: true,
          sourceRoot,
          requiredPaths: [
            "customizations/dashboard/manifest.json",
            "customizations/dashboard/openclaw-dashboard-customizations.patch",
          ],
        },
      }),
      cron: {
        status: vi.fn(async () => ({ enabled: true })),
        list: vi.fn(async () => []),
      },
      getRuntimeSnapshot: () => ({
        channels: {},
        channelAccounts: {},
      }),
    } as unknown as Partial<GatewayRequestContext>);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        checks: expect.objectContaining({
          customizationProtection: expect.objectContaining({
            status: "protected",
            fileCount: 1,
            missingFileCount: 0,
            contentDriftCount: 0,
            patchApplies: true,
            updateGuardActive: true,
          }),
        }),
        issues: [],
      }),
    );
  });

  it("turns stale dashboard customization bundles into ops issues", async () => {
    installRuntimeMocks({ loadedModelBytes: 0, processRssKb: 0 });
    const sourceRoot = createCustomizationFixture({ mutateAfterManifest: true });
    const respond = await callOpsSummary({
      getRuntimeConfig: () => ({
        update: {
          preserveDirty: true,
          sourceRoot,
          requiredPaths: [
            "customizations/dashboard/manifest.json",
            "customizations/dashboard/openclaw-dashboard-customizations.patch",
          ],
        },
      }),
      cron: {
        status: vi.fn(async () => ({ enabled: true })),
        list: vi.fn(async () => []),
      },
      getRuntimeSnapshot: () => ({
        channels: {},
        channelAccounts: {},
      }),
    } as unknown as Partial<GatewayRequestContext>);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        state: "needs_review",
        checks: expect.objectContaining({
          customizationProtection: expect.objectContaining({
            status: "needs_review",
            contentDriftCount: 1,
          }),
        }),
        issues: [
          expect.objectContaining({
            id: "customization-protection",
            source: "customization",
            title: "Dashboard customization protection needs review",
            plainSummary: "The dashboard customization bundle is not fully current.",
          }),
        ],
      }),
    );
  });
});
