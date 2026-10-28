import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as materialize from "../../config/materialize.js";
import * as deferredMigrations from "../../infra/deferred-plugin-migrations.js";
import { GatewayLockNamespaceError } from "../../infra/gateway-lock-payload.js";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import { SqliteReadOnlyInspectionContentionError } from "../../infra/sqlite-readonly-worker-protocol.js";
import { DoctorMaintenanceRefusalError } from "../../infra/update-doctor-result.js";
import { UpdateRequesterRevokedError } from "../../infra/update-requester-authority.js";
import * as installSurface from "../../infra/update-runner-install-surface.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import { readUpdateChannelConfig } from "./update-command-config.js";
import { installFreshUpdateFixture } from "./update-command-fresh.test-support.js";
import {
  resolveMutableUpdateFailure,
  withUpdateAdmissionReporting,
} from "./update-command-result.js";
import { updateCommand } from "./update-command.js";

const { fixture } = installFreshUpdateFixture();

it("preserves the ownership refusal through dry-run config loading without leaking holder details", async () => {
  const privateDetail = "synthetic-private-holder";
  const cause = new DoctorMaintenanceRefusalError(
    privateDetail,
    { kind: "data-at-risk", reason: "gateway-state-unverified" },
    {
      cause: new GatewayLockError(
        privateDetail,
        new GatewayLockNamespaceError({ host: privateDetail, pid: 4242 }),
      ),
    },
  );
  vi.spyOn(deferredMigrations, "readDeferredPluginMigrationsAsync").mockRejectedValue(cause);

  await expect(updateCommand({ channel: "dev", dryRun: true, json: true })).rejects.toMatchObject({
    code: 1,
  });

  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({
      reason: "config-read-failed",
      recovery: expect.objectContaining({
        serviceRestartSafe: false,
        dataAtRisk: "gateway-state-unverified",
      }),
      failedStep: expect.objectContaining({
        failureFacts: [expect.objectContaining({ code: "gateway-ownership-unverified" })],
      }),
    }),
  );
  const output = JSON.stringify([
    vi.mocked(defaultRuntime.writeJson).mock.calls,
    vi.mocked(defaultRuntime.error).mock.calls,
  ]);
  expect(output).toContain("openclaw gateway recover-lock");
  expect(output).not.toContain(privateDetail);
  expect(fs.existsSync(fixture.databasePath)).toBe(false);
});

it.each(["contention", "cleanup", "data-at-risk", "revoked"] as const)(
  "preserves config read control flow for %s before reporting",
  async (kind) => {
    const cause =
      kind === "contention"
        ? new SqliteReadOnlyInspectionContentionError("Synthetic contention")
        : kind === "cleanup"
          ? new CommandProcessCleanupError({
              cause: new GatewayLockNamespaceError({ host: "synthetic-private-holder", pid: 4242 }),
            })
          : kind === "revoked"
            ? new UpdateRequesterRevokedError()
            : new DoctorMaintenanceRefusalError(
                "synthetic-private-holder",
                { kind: "data-at-risk", reason: "gateway-state-unverified" },
                {
                  cause: new GatewayLockNamespaceError({
                    host: "synthetic-private-holder",
                    pid: 4242,
                  }),
                },
              );
    vi.spyOn(deferredMigrations, "readDeferredPluginMigrationsAsync").mockRejectedValue(cause);

    const caught = await readUpdateChannelConfig(false).catch((error: unknown) => error);
    expect(caught).toBe(cause);
    const retained = await readUpdateChannelConfig(false, { tolerateReadFailure: true });
    expect(retained.configReadFailure).toBe(cause);

    if (kind !== "cleanup" && kind !== "data-at-risk") {
      return;
    }
    const originalRecovery = vi.fn(async () => ({
      serviceRestartSafe: true as const,
      version: "2026.10.3",
    }));
    const outcome = resolveMutableUpdateFailure({
      cause: caught,
      durationMs: 0,
      mode: "npm",
      root: fixture.root,
      originalRecovery,
    });
    if (kind === "cleanup") {
      await expect(outcome).rejects.toBe(cause);
      await expect(
        withUpdateAdmissionReporting({ json: true }, async () => {
          throw caught;
        }),
      ).rejects.toBe(cause);
    } else {
      const { result, failure } = await outcome;
      expect(failure.cause).toBe(cause);
      expect(result.recovery).toMatchObject({
        serviceRestartSafe: false,
        dataAtRisk: "gateway-state-unverified",
      });
      expect(result.failedStep?.failureFacts).toEqual([
        expect.objectContaining({ code: "gateway-ownership-unverified" }),
      ]);
      expect(JSON.stringify([result, vi.mocked(defaultRuntime.error).mock.calls])).not.toContain(
        "synthetic-private-holder",
      );
    }
    expect(originalRecovery).not.toHaveBeenCalled();
  },
);

it.each([
  { kind: "unknown key", config: { unknownSetting: true }, affectedKey: "<root>", dryRun: false },
  { kind: "unknown key", config: { unknownSetting: true }, affectedKey: "<root>", dryRun: true },
  {
    kind: "invalid core field",
    config: { gateway: { port: "invalid" } },
    affectedKey: "gateway.port",
    dryRun: false,
  },
])(
  "identifies $kind during installed admission (dryRun=$dryRun)",
  async ({ config, dryRun, affectedKey }) => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH!;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const original = JSON.stringify(config);
    fs.writeFileSync(configPath, original);

    const update = updateCommand({
      admission: "installed",
      tag: "2026.9.2",
      json: true,
      yes: true,
      restart: false,
      dryRun,
    });
    if (dryRun) {
      await update;
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          dryRun: true,
          notes: [expect.stringMatching(/configuration is invalid[\s\S]*openclaw doctor --fix/)],
        }),
      );
    } else {
      await expect(update).rejects.toMatchObject({ code: 1 });
      const invalidConfigStep = expect.objectContaining({
        name: "invalid-config",
        exitCode: 1,
        failureFacts: [
          expect.objectContaining({
            check: "invalid-config",
            code: "invalid-config",
            affectedKey,
          }),
        ],
      });
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "error",
          reason: "invalid-config",
          failedStep: invalidConfigStep,
          steps: expect.arrayContaining([invalidConfigStep]),
        }),
      );
    }
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.existsSync(fixture.databasePath)).toBe(false);
  },
);

it.each(["file", "materialization", "include", "include-syntax"])(
  "classifies a config %s failure without changing its source",
  async (failure) => {
    vi.spyOn(installSurface, "resolveUpdateInstallSurface").mockRejectedValue(
      new Error("Package-manager inspection must not replace the config failure"),
    );
    const configPath = process.env.OPENCLAW_CONFIG_PATH!;
    const original = failure.startsWith("include")
      ? '{"$include":"./extra.json"}'
      : '{"gateway":{"mode":"local"}}';
    if (failure === "file") {
      fs.mkdirSync(configPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, original);
      if (failure === "materialization") {
        vi.spyOn(materialize, "materializeRuntimeConfig").mockImplementation(() => {
          throw new Error("Synthetic materialization failure after reading source bytes");
        });
      } else if (failure === "include-syntax") {
        fs.writeFileSync(path.join(path.dirname(configPath), "extra.json"), "{");
      }
    }

    await expect(
      updateCommand({
        admission: "installed",
        channel: "stable",
        tag: "2026.9.2",
        json: true,
        yes: true,
        restart: false,
      }),
    ).rejects.toMatchObject({ code: 1 });

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        reason: failure === "include-syntax" ? "invalid-config" : "config-read-failed",
        steps: [
          expect.objectContaining({
            failureFacts: [
              expect.objectContaining({
                check: failure === "include-syntax" ? "invalid-config" : "config",
                code:
                  failure === "file"
                    ? "EISDIR"
                    : failure === "include-syntax"
                      ? "invalid-config"
                      : "config-read-failed",
              }),
            ],
          }),
        ],
      }),
    );
    if (failure === "file") {
      expect(fs.statSync(configPath).isDirectory()).toBe(true);
    } else {
      expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    }
    expect(fs.existsSync(fixture.databasePath)).toBe(false);
  },
);
