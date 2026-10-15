import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { DoctorOptions } from "../commands/doctor.types.js";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as sqliteSnapshot from "../infra/sqlite-snapshot.js";
import {
  listSecretStoreEntries,
  readSecretStoreExecEnvironment,
  readSecretStoreValue,
  writeSecretStoreEntry,
} from "../secrets/store/secret-store.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { detectGatewayAuthHealth } from "./doctor-gateway-auth.js";
import {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
} from "./doctor-health-contributions.test-support.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const tokenRef = { source: "store", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" } as const;

async function createFixture(
  value = REDACTED_SENTINEL,
  options: DoctorOptions = {},
  kind: "secret" | "env" = "secret",
) {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("doctor-gateway-token-repair-") };
  const entry = { scope: { kind: "team" as const }, name: tokenRef.id, database: { env } };
  await writeSecretStoreEntry({
    ...entry,
    value: "synthetic-original-token",
    kind,
    updatedBy: "fixture",
    ...(kind === "secret" ? { allowedHosts: ["gateway.example.test"] } : {}),
  });
  // Model already-corrupt published state without using the guarded store writer.
  openOpenClawStateDatabase({ env })
    .db.prepare("UPDATE secret_store_entries SET value = ? WHERE name = ?")
    .run(value, entry.name);
  const cfg: OpenClawConfig = {
    gateway: { mode: "local", auth: { mode: "token", token: tokenRef } },
  };
  const ctx = createDoctorHealthFlowContext({
    cfg,
    env,
    options: { nonInteractive: true, ...options },
    configPath: path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"),
  });
  const stateDir = path.dirname(resolveOpenClawStateSqlitePath(env));
  return {
    ctx,
    entry,
    backups: () =>
      fs
        .readdirSync(stateDir)
        .filter((name) => name.includes(".doctor-gateway-token."))
        .map((name) => path.join(stateDir, name)),
  };
}

async function runGatewayAuth(ctx: ReturnType<typeof createDoctorHealthFlowContext>) {
  const contribution = resolveDoctorHealthContributions().find(
    (entry) => entry.id === "doctor:gateway-auth",
  );
  if (!contribution) {
    throw new Error("Gateway auth Doctor contribution is missing");
  }
  await contribution.run(ctx);
}

beforeEach(() => vi.mocked(note).mockClear());
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

describe("Doctor Gateway token store repair", () => {
  it.each(["config", "environment"])(
    "records a warning for a redacted optional proxy password from %s",
    async (source) => {
      const fixture = await createFixture("synthetic-healthy-token", {
        repair: true,
        generateGatewayToken: true,
      });
      fixture.ctx.cfg.gateway = {
        auth: {
          mode: "trusted-proxy",
          trustedProxy: { userHeader: "x-forwarded-user" },
          ...(source === "config" ? { password: REDACTED_SENTINEL } : {}),
        },
      };
      if (source === "environment") {
        fixture.ctx.env = { ...fixture.ctx.env, OPENCLAW_GATEWAY_PASSWORD: REDACTED_SENTINEL };
      }
      expect(await detectGatewayAuthHealth(fixture.ctx)).toEqual([
        expect.objectContaining({
          severity: "warning",
          path: "gateway.auth.password",
          message: expect.stringContaining("local password fallback"),
          fixHint: expect.stringContaining("Replace"),
        }),
      ]);
      await runGatewayAuth(fixture.ctx);
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining("local password fallback"),
        "Gateway auth",
      );
      expect(fixture.ctx.cfg.gateway?.auth?.mode).toBe("trusted-proxy");
      expect(fixture.ctx.updateWarnings).toEqual(
        expect.arrayContaining([expect.stringContaining("local password fallback")]),
      );
      expect(fixture.backups()).toEqual([]);
    },
  );

  it.each([false, true])(
    "leaves a managed SecretRef unchanged without an eligible repair (healthy=%s)",
    async (healthy) => {
      const value = healthy ? "synthetic-healthy-token" : REDACTED_SENTINEL;
      const fixture = await createFixture(value, healthy ? { generateGatewayToken: true } : {});
      expect(await detectGatewayAuthHealth(fixture.ctx)).toEqual(
        healthy
          ? []
          : [
              expect.objectContaining({
                severity: "error",
                requirement: "SECRET_REF_REDACTED_VALUE",
                message: expect.stringContaining(tokenRef.id),
                fixHint: expect.stringContaining("openclaw doctor --fix"),
              }),
            ],
      );
      await runGatewayAuth(fixture.ctx);
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining(
          healthy
            ? `generation skipped because gateway.auth.token is managed by SecretRef store:default:${tokenRef.id}`
            : tokenRef.id,
        ),
        "Gateway auth",
      );
      expect(await readSecretStoreValue(fixture.entry)).toEqual({ ok: true, value });
      expect(fixture.backups()).toEqual([]);
    },
  );

  it.each([
    { kind: "secret", options: { repair: true } },
    { kind: "env", options: { generateGatewayToken: true } },
  ] as const)(
    "repairs redacted $kind state with $options while preserving the reference and verified backup",
    async ({ kind, options }) => {
      const fixture = await createFixture(REDACTED_SENTINEL, options, kind);
      await runGatewayAuth(fixture.ctx);
      const repaired = await readSecretStoreValue(fixture.entry);
      expect(repaired).toEqual({ ok: true, value: expect.stringMatching(/^[a-f0-9]{48}$/u) });
      expect(fixture.ctx.cfg.gateway?.auth?.token).toEqual(tokenRef);
      expect(await detectGatewayAuthHealth(fixture.ctx)).toEqual([]);
      expect(await listSecretStoreEntries(fixture.entry)).toEqual([
        expect.objectContaining({
          kind,
          ...(kind === "secret" ? { allowedHosts: ["gateway.example.test"] } : {}),
        }),
      ]);
      const execEnvironment = await readSecretStoreExecEnvironment({
        includeSecretSentinels: false,
        database: fixture.entry.database,
      });
      expect(execEnvironment.env?.[tokenRef.id]).toBe(
        kind === "env" && repaired.ok ? repaired.value : undefined,
      );
      const backup = expectDefined(fixture.backups()[0], "verified Gateway token backup");
      expect(fixture.backups()).toHaveLength(1);
      expect(await readSecretStoreValue({ ...fixture.entry, database: { path: backup } })).toEqual({
        ok: true,
        value: REDACTED_SENTINEL,
      });
      expect(note).toHaveBeenCalledWith(expect.stringContaining("re-pair"), "Gateway auth");
      expect(note).toHaveBeenCalledWith(expect.stringContaining(backup), "Gateway auth");
    },
  );

  it.each(["backup failure", "replacement", "kind change"] as const)(
    "settles token repair safely after %s during the backup",
    async (change) => {
      const fixture = await createFixture(REDACTED_SENTINEL, { repair: true });
      const snapshot = sqliteSnapshot.createVerifiedSqliteSnapshot;
      const backup = vi.spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot");
      if (change === "backup failure") {
        backup.mockRejectedValueOnce(new Error("synthetic disk full"));
      } else {
        backup.mockImplementationOnce(async (options) => {
          const result = await snapshot(options);
          if (change === "replacement") {
            await writeSecretStoreEntry({
              ...fixture.entry,
              kind: "secret",
              value: "synthetic-concurrent-replacement",
              updatedBy: "concurrent-writer",
            });
          } else {
            openOpenClawStateDatabase(fixture.entry.database)
              .db.prepare(
                "UPDATE secret_store_entries SET kind = 'env', allowed_hosts = NULL WHERE name = ?",
              )
              .run(tokenRef.id);
          }
          return result;
        });
      }
      await runGatewayAuth(fixture.ctx);
      if (change === "kind change") {
        const result = await readSecretStoreExecEnvironment({
          includeSecretSentinels: false,
          database: fixture.entry.database,
        });
        expect(result.env?.[tokenRef.id]).toMatch(/^[a-f0-9]{48}$/u);
      } else {
        expect(await readSecretStoreValue(fixture.entry)).toEqual({
          ok: true,
          value: change === "replacement" ? "synthetic-concurrent-replacement" : REDACTED_SENTINEL,
        });
        expect(fixture.ctx.updateWarnings).toContainEqual(
          expect.stringContaining(change === "replacement" ? tokenRef.id : "synthetic disk full"),
        );
        if (change === "backup failure") {
          expect(fixture.backups()).toEqual([]);
        }
      }
    },
  );
});
