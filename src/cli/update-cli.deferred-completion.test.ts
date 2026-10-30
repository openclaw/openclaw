import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { listUpdateRuns } from "../infra/update-run-ledger.js";
import * as cli from "./update-cli.deferred-completion.test-support.js";

describe("update-cli child-owned deferred completion", () => {
  const f = cli.installDeferredCompletionFixture();

  it("refuses a post-core run missing from history before Doctor or plugin effects", async () => {
    const ledger = await import("../infra/update-run-ledger.js");
    const sourceRuntime = await import("./update-cli/update-command-runtime.js");
    const preparation = vi
      .spyOn(sourceRuntime, "completeSourceUpdateRuntime")
      .mockRejectedValue(new Error("Missing-run regression reached runtime preparation."));
    const runId = "53e56de0-a951-4b3d-af1a-9e4f1ac5a069";
    expect(ledger.getUpdateRun(runId)).toBeUndefined();
    const history = ledger.listUpdateRuns({ limit: 100 });
    cli.readPackageVersion.mockResolvedValue("2026.9.4");

    const failure = await f
      .runPostCoreCommand(
        { restart: false, json: true },
        {
          OPENCLAW_UPDATE_RUN_ID: runId,
          OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
          OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL: "beta",
        },
      )
      .catch((error: unknown) => error);
    expect(preparation).not.toHaveBeenCalled();
    expect(failure).toMatchObject({
      name: "UpdateCommandRecoveryPendingError",
      message: "Post-core update run is unavailable; resume cannot verify its owner.",
    });

    expect(vi.mocked(cli.runExec).mock.calls.some(([, args]) => args.includes("doctor"))).toBe(
      false,
    );
    expect(cli.syncPluginsForUpdateChannel).not.toHaveBeenCalled();
    expect(cli.updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(cli.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    expect(cli.replaceConfigFile).not.toHaveBeenCalled();
    expect(cli.defaultRuntime.exit).not.toHaveBeenCalledWith(0);
    expect(ledger.listUpdateRuns({ limit: 100 })).toEqual(history);
  });

  it.each([false, true])(
    "finalize commits a downgrade only when valid=%s without changing channels",
    async (valid) => {
      const config = f.stableConfig({ meta: { lastTouchedVersion: "9999.1.1" } });
      vi.mocked(cli.readConfigFileSnapshot).mockResolvedValue(f.configSnapshot(config, { valid }));

      vi.mocked(cli.resolveGatewayInstallEntrypoint).mockResolvedValue(
        f.FRESH_POST_UPDATE_ENTRYPOINT,
      );
      if (valid) {
        await cli.updateFinalizeCommand({ json: true, yes: true });
        expect(cli.replaceConfigFile).toHaveBeenCalledExactlyOnceWith({ nextConfig: config });
        const options = vi.mocked(cli.mutateConfigFileWithRetry).mock.calls[0]?.[0].writeOptions;
        for (const guard of [options?.assertCurrent, options?.beforeCommit]) {
          expect(guard).toThrow("Update operation ownership has closed.");
        }
      } else {
        await expect(cli.updateFinalizeCommand({ json: true, yes: true })).rejects.toEqual(
          new cli.ExitError(1),
        );
        expect(cli.observeUpdateGatewayReadiness).toHaveBeenCalledOnce();
        const recorded = listUpdateRuns({ limit: 1 })[0];
        const message =
          "Gateway readiness was not verified; service status: stopped. Check openclaw gateway status --deep.";
        expect(recorded?.status).toBe("failed");
        expect(recorded?.verification).toEqual({
          serviceRunning: false,
          port: 18789,
          pluginErrors: [],
          channelsReady: false,
          settled: false,
          readyz: false,
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        });
        expect(
          recorded?.steps.filter((step) => step.step === "gateway recovery verification"),
        ).toEqual([
          {
            step: "gateway recovery verification",
            status: "failed",
            exitCode: 1,
            detail: `Exit code: 1; ${message}`,
            failureFacts: [{ check: "settled", code: "stopped-free", message }],
          },
        ]);
        expect(cli.replaceConfigFile).not.toHaveBeenCalled();
      }
      expect(cli.updateGitCheckout).not.toHaveBeenCalled();
    },
  );

  it("reports a completed missing-payload repair instead of the later bulk skip", async () => {
    const installPath = f.createCaseDir("openclaw-repaired-plugin-summary");
    fsSync.mkdirSync(installPath, { recursive: true });
    const records = {
      demo: { source: "npm", spec: "@example/demo", installPath, version: "1.0.0" },
    } satisfies Record<string, PluginInstallRecord>;
    const config = { plugins: { entries: { demo: { enabled: true } } } } satisfies OpenClawConfig;
    vi.mocked(cli.readConfigFileSnapshot).mockResolvedValue(f.configSnapshot(config));
    cli.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    f.mockFileBackedPathExists();
    // Child-owned completion needs the installed candidate's Doctor entrypoint.
    vi.mocked(cli.resolveGatewayInstallEntrypoint).mockImplementation(async (root) => {
      expect(root).toBe(process.cwd());
      return f.FRESH_POST_UPDATE_ENTRYPOINT;
    });
    const repaired = {
      pluginId: "demo",
      status: "updated" as const,
      message: 'Repaired plugin "demo".',
    };
    cli.updateNpmInstalledPlugins.mockImplementation(async ({ config: current, skipIds }) => {
      if (skipIds?.has("demo")) {
        return {
          config: current,
          changed: false,
          outcomes: [
            { ...repaired, status: "skipped", message: 'Skipping "demo" (already updated).' },
          ],
        };
      }
      const payload = {
        "package.json": JSON.stringify({
          name: "@example/demo",
          version: "1.0.0",
          openclaw: { extensions: ["./index.js"] },
        }),
        "openclaw.plugin.json": JSON.stringify({ id: "demo", configSchema: { type: "object" } }),
        "index.js": "module.exports = {};\n",
      };
      for (const [file, source] of Object.entries(payload)) {
        fsSync.writeFileSync(path.join(installPath, file), source);
      }
      return { config: current, changed: true, outcomes: [repaired] };
    });
    cli.runPostCorePluginConvergenceSpy.mockImplementationOnce(async ({ cfg }) => ({
      ...f.postCoreConvergenceResult(),
      installRecords: records,
      config: cfg,
    }));

    await f.runPostCoreCommand({ yes: true, restart: false });

    expect(cli.defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(f.getLogOutput()).toContain("Plugin updates: 1 updated, 0 unchanged.");
    expect(f.getLogOutput()).not.toContain("1 skipped");
  });

  it.each(["channel-less", "pre-attempt", "expired"] as const)(
    "does not restore backup channels from a %s snapshot",
    async (kind) => {
      const expired = kind === "expired";
      const ageMs = expired ? 7 * 60 * 60 * 1000 : kind === "pre-attempt" ? 60_000 : 0;
      const startedAgoMs = expired ? 8 * 60 * 60 * 1000 : 0;
      const snapshot: OpenClawConfig = expired
        ? { channels: { whatsapp: { enabled: true } } }
        : kind === "channel-less"
          ? f.stableConfig()
          : f.stableWhatsAppConfig();
      const tempDir = f.createCaseDir("openclaw-update");
      const configPath = path.join(tempDir, "openclaw.json");
      const postDoctorConfig = f.stableConfig();
      await fs.mkdir(tempDir, { recursive: true });
      const now = Date.now();
      for (const suffix of expired ? [".pre-update"] : [".pre-update", ".bak"]) {
        const snapshotPath = `${configPath}${suffix}`;
        await f.writeJsonFixture(
          snapshotPath,
          suffix === ".bak" ? f.stableWhatsAppConfig() : snapshot,
        );
        if (ageMs) {
          const staleTime = new Date(now - ageMs);
          await fs.utimes(snapshotPath, staleTime, staleTime);
        }
      }
      await f.writeJsonFixture(configPath, postDoctorConfig);
      f.mockPostDoctorSnapshot(configPath, postDoctorConfig, { preserveParsed: expired });

      await f.runPostCoreUpdate({
        OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS: String(now - startedAgoMs),
      });

      expect(f.syncPluginCall()?.config?.channels?.whatsapp).toBeUndefined();
      expect(f.lastReplaceConfigCall()).toBeUndefined();
    },
  );
});
