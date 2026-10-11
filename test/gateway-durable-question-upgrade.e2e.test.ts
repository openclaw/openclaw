import { readFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../packages/gateway-protocol/src/client-info.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import {
  activateUpgradeBackup,
  createQuestionUpgradeFixture,
  inspectUpgradeDatabases,
  parseUpgradeCliJson,
  UPGRADE_REPLY,
} from "./helpers/durable-question-upgrade.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const stableRoot = process.env.OPENCLAW_TEST_INSTALLED_STABLE_ROOT;
const candidateBinary = path.resolve(
  process.env.OPENCLAW_TEST_UPGRADE_CANDIDATE_ENTRYPOINT ?? "dist/index.js",
);

it.skipIf(!stableRoot)(
  "upgrades actual installed stable state through Doctor and restores its verified complete backup for binary rollback",
  { timeout: 300_000 },
  async ({ signal }) => {
    if (!stableRoot) {
      throw new Error("Installed stable opt-in root is required");
    }
    const stableManifest = JSON.parse(
      await readFile(path.join(stableRoot, "package.json"), "utf8"),
    );
    expect(stableManifest.version).toBe("2026.10.1");
    expect(stableManifest.openclaw.schemaVersions).toEqual({ agent: 24, state: 20 });
    const fixture = await createQuestionUpgradeFixture(stableRoot, signal);
    const { instance } = fixture;
    let client: Awaited<ReturnType<typeof acquireGatewayTestClient>> | undefined;
    const trace = (phase: string, facts: Record<string, unknown>) => {
      process.stderr.write(
        `[durable-question:installed-upgrade] ${JSON.stringify({ phase, ...facts })}\n`,
      );
    };
    const identity = loadOrCreateDeviceIdentity({
      path: instance.state.path("upgrade-device.sqlite"),
    });
    let onUsageUpdated: ((payload: unknown) => void) | undefined;
    const persistUsageCache = async () => {
      if (!client) {
        throw new Error("Upgrade proof client must be connected");
      }
      let dispose = () => {};
      const updated = new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const reason: unknown = signal.reason;
          reject(
            reason instanceof Error
              ? reason
              : new Error("Upgrade proof aborted", { cause: reason }),
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
        dispose = () => {
          onUsageUpdated = undefined;
          signal.removeEventListener("abort", onAbort);
        };
        onUsageUpdated = (payload) => {
          if (
            !isRecord(payload) ||
            payload.agentId !== "main" ||
            typeof payload.usageUpdatedAt !== "number"
          ) {
            return;
          }
          if (payload.usageRefreshFailed === true) {
            reject(new Error("Native usage cache refresh failed"));
          } else {
            resolve();
          }
        };
      });
      // Register before requesting: the committed publication may precede the RPC reply.
      void updated.catch(() => {});
      try {
        signal.throwIfAborted();
        const summary = await client.request("usage.cost", { days: 1 });
        if (!isRecord(summary) || !isRecord(summary.cacheStatus)) {
          throw new Error("Native usage response omitted cache status");
        }
        if (summary.cacheStatus.status !== "fresh") {
          await updated;
          const confirmed = await client.request("usage.cost", { days: 1 });
          if (!isRecord(confirmed) || !isRecord(confirmed.cacheStatus)) {
            throw new Error("Native usage confirmation omitted cache status");
          }
          expect(confirmed.cacheStatus.cachedFiles).toBeGreaterThan(0);
          expect(confirmed.cacheStatus.staleFiles).toBe(0);
        }
      } finally {
        dispose();
      }
    };
    const connect = () =>
      acquireGatewayTestClient(
        {
          url: instance.url,
          token: instance.gatewayToken,
          deviceIdentity: identity,
          clientName: GATEWAY_CLIENT_NAMES.TUI,
          mode: GATEWAY_CLIENT_MODES.UI,
          clientVersion: "test",
          platform: process.platform,
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write"],
          onEvent: (event) => {
            if (event.event === "chat.metadata.changed") {
              onUsageUpdated?.(event.payload);
            }
          },
        },
        {
          signal,
          timeoutMs: 30_000,
          timeoutMessage: "Upgrade proof connection unavailable",
          closeMessage: "Upgrade proof connection closed",
        },
      );
    const sessionKey = "agent:main:installed-upgrade-proof";
    const assertSettings = async () => {
      const settings = await instance.cli(["config", "get", "agents.defaults.model", "--json"]);
      expect(settings.code).toBe(0);
      expect(parseUpgradeCliJson(settings.stdout)).toMatchObject({
        primary: fixture.model.modelRef,
      });
    };
    const assertHistory = async () => {
      if (!client) {
        throw new Error("Upgrade proof client must be connected");
      }
      const history = await client.request("chat.history", { sessionKey, limit: 20 });
      expect(JSON.stringify(history)).toContain(UPGRADE_REPLY);
      const sessions = await client.request("sessions.list", {});
      expect(JSON.stringify(sessions)).toContain(sessionKey);
    };
    const stop = async () => {
      await client?.stopAndWait();
      client = undefined;
      await instance.stopGateway();
    };
    await runQaGatewayFixture(
      async () => {
        await instance.startGateway();
        client = await connect();
        await client.request("sessions.create", {
          key: sessionKey,
          agentId: "main",
          model: fixture.model.modelRef,
          cwd: instance.state.workspaceDir,
        });
        const asking = await client.request<{ runId: string }>(
          "chat.send",
          {
            sessionKey,
            message: "SYNTHETIC_STABLE_UPGRADE_PROOF",
            idempotencyKey: "installed-stable-turn",
            deliver: false,
          },
          { expectFinal: false },
        );
        expect(
          await client.request("agent.wait", { runId: asking.runId, timeoutMs: 30_000 }),
        ).toMatchObject({ status: "ok" });
        await assertHistory();
        await assertSettings();
        await persistUsageCache();
        await stop();
        const baseline = await inspectUpgradeDatabases(instance.state.stateDir);
        const baselineAgent = baseline.find((row) => row.cacheCount !== undefined);
        expect(baselineAgent?.version).toBe(24);
        expect(baselineAgent?.cacheCount).toBeGreaterThan(0);
        expect(baseline.some((row) => row.version === 20)).toBe(true);
        trace("stable-persisted", {
          binaryVersion: stableManifest.version,
          versions: baseline.map((row) => row.version),
          cacheCount: baselineAgent?.cacheCount,
          cacheDigest: baselineAgent?.cacheDigest,
        });
        const archive = instance.state.path("stable-complete.tar.gz");
        const backup = await instance.cli([
          "backup",
          "create",
          "--output",
          archive,
          "--verify",
          "--json",
        ]);
        expect(backup.code).toBe(0);
        expect(parseUpgradeCliJson(backup.stdout).archivePath).toBe(archive);
        expect((await instance.cli(["backup", "verify", archive, "--json"])).code).toBe(0);
        fixture.useBinary(candidateBinary);
        const doctor = await instance.cli([
          "doctor",
          "--fix",
          "--non-interactive",
          "--no-workspace-suggestions",
        ]);
        expect(doctor.code).toBe(0);
        const migrated = await inspectUpgradeDatabases(instance.state.stateDir);
        const migratedAgent = migrated.find((row) => row.cacheCount !== undefined);
        expect(migratedAgent?.version).toBe(26);
        expect(migratedAgent?.cacheDigest).toBe(baselineAgent?.cacheDigest);
        expect(migrated.some((row) => row.version === 20)).toBe(true);
        trace("candidate-doctor", {
          versions: migrated.map((row) => row.version),
          cacheCount: migratedAgent?.cacheCount,
          cacheDigest: migratedAgent?.cacheDigest,
        });
        await instance.startGateway();
        client = await connect();
        await assertHistory();
        await assertSettings();
        await stop();
        const beforeRefusal = await inspectUpgradeDatabases(instance.state.stateDir);
        fixture.useBinary(path.join(stableRoot, "openclaw.mjs"));
        let refused = false;
        try {
          await instance.startGateway();
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/schema|version|incompatib|newer|upgrade/iu.test(error.message)
          ) {
            throw new Error("Stable startup failed outside the expected newer-schema refusal", {
              cause: error,
            });
          }
          refused = true;
        } finally {
          await instance.stopGateway();
        }
        expect(refused).toBe(true);
        expect(await inspectUpgradeDatabases(instance.state.stateDir)).toEqual(beforeRefusal);
        trace("stable-rejected-newer-installation", {
          refused,
          canonicalDatabaseDigestsUnchanged: true,
          versions: beforeRefusal.map((row) => row.version),
        });
        fixture.useBinary(candidateBinary);
        const restoreTarget = instance.state.path("restore-staging");
        const restore = await instance.cli([
          "backup",
          "restore",
          archive,
          "--target",
          restoreTarget,
          "--json",
        ]);
        expect(restore.code).toBe(0);
        const assetCount = await activateUpgradeBackup({
          root: instance.state.root,
          restoreTarget,
          restored: parseUpgradeCliJson(restore.stdout),
        });
        const restored = await inspectUpgradeDatabases(instance.state.stateDir);
        const restoredAgent = restored.find((row) => row.cacheCount !== undefined);
        expect(restoredAgent?.version).toBe(24);
        expect(restoredAgent?.cacheDigest).toBe(baselineAgent?.cacheDigest);
        expect(restored.some((row) => row.version === 20)).toBe(true);
        fixture.useBinary(path.join(stableRoot, "openclaw.mjs"));
        expect(
          (
            await instance.cli(["doctor", "--non-interactive", "--no-workspace-suggestions"], {
              timeoutMs: 120_000,
            })
          ).code,
        ).toBe(0);
        await instance.startGateway();
        client = await connect();
        await assertHistory();
        await assertSettings();
        await persistUsageCache();
        await stop();
        trace("complete-backup-rollback-stable-ready", {
          binaryVersion: stableManifest.version,
          versions: restored.map((row) => row.version),
          restoredAssets: assetCount,
          cacheCount: restoredAgent?.cacheCount,
          cacheDigest: restoredAgent?.cacheDigest,
          retainedHistory: true,
          retainedSettings: true,
        });
      },
      stop,
      () => fixture.cleanup(),
    );
  },
);
