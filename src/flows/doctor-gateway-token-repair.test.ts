import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { DoctorOptions } from "../commands/doctor.types.js";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";
import * as sqliteSnapshot from "../infra/sqlite-snapshot.js";
import {
  listSecretStoreEntries as listEntries,
  readSecretStoreExecEnvironment as readExecEnv,
  readSecretStoreValue as readToken,
  writeSecretStoreEntry as writeToken,
} from "../secrets/store/secret-store.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase as openStateDb,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { detectGatewayAuthHealth } from "./doctor-gateway-auth.js";
import {
  createDoctorHealthFlowContext as createContext,
  resolveDoctorHealthContributions as getContributions,
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
  await writeToken({
    ...entry,
    value: "synthetic-original-token",
    kind,
    updatedBy: "fixture",
    ...(kind === "secret" ? { allowedHosts: ["gateway.example.test"] } : {}),
  });
  // Model already-corrupt published state without using the guarded store writer.
  openStateDb({ env })
    .db.prepare("UPDATE secret_store_entries SET value = ? WHERE name = ?")
    .run(value, entry.name);
  const ctx = createContext({
    cfg: { gateway: { mode: "local", auth: { mode: "token", token: tokenRef } } },
    env,
    options: { nonInteractive: true, ...options },
  });
  const stateDir = path.dirname(resolveOpenClawStateSqlitePath(env));
  return {
    ctx,
    entry,
    run: () =>
      expectDefined(
        getContributions().find((item) => item.id === "doctor:gateway-auth"),
        "Gateway auth Doctor contribution",
      ).run(ctx),
    backups: () =>
      fs
        .readdirSync(stateDir)
        .filter((name) => name.includes(".doctor-gateway-token."))
        .map((name) => path.join(stateDir, name)),
  };
}

function expectNote(fragment: string) {
  expect(note).toHaveBeenCalledWith(expect.stringContaining(fragment), "Gateway auth");
}

beforeEach(() => vi.mocked(note).mockClear());
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

it.each([
  ["config", true],
  ["environment", true],
  ["token", false],
  ["token", true],
] as const)("preserves %s credentials (healthy=%s)", async (source, healthy) => {
  const proxy = source !== "token";
  const value = healthy ? "synthetic-healthy-token" : REDACTED_SENTINEL;
  const { ctx, entry, run, backups } = await createFixture(value, {
    repair: proxy,
    generateGatewayToken: healthy,
  });
  if (proxy) {
    ctx.cfg.gateway = {
      auth: {
        mode: "trusted-proxy",
        trustedProxy: { userHeader: "x-forwarded-user" },
        ...(source === "config" ? { password: REDACTED_SENTINEL } : {}),
      },
    };
    if (source === "environment") {
      ctx.env = { ...ctx.env, OPENCLAW_GATEWAY_PASSWORD: REDACTED_SENTINEL };
    }
  }
  const finding = proxy
    ? {
        severity: "warning",
        path: "gateway.auth.password",
        message: expect.stringContaining("local password fallback"),
        fixHint: expect.stringContaining("Replace"),
      }
    : {
        severity: "error",
        requirement: "SECRET_REF_REDACTED_VALUE",
        message: expect.stringContaining(tokenRef.id),
        fixHint: expect.stringContaining("openclaw doctor --fix"),
      };
  expect(await detectGatewayAuthHealth(ctx)).toEqual(
    proxy || !healthy ? [expect.objectContaining(finding)] : [],
  );
  await run();
  expectNote(
    proxy
      ? "local password fallback"
      : healthy
        ? "generation skipped because gateway.auth.token is managed by SecretRef store:default:" +
          tokenRef.id
        : tokenRef.id,
  );
  expect(await readToken(entry)).toEqual({ ok: true, value });
  expect(backups()).toEqual([]);
  if (proxy) {
    expect(ctx).toMatchObject({
      cfg: { gateway: { auth: { mode: "trusted-proxy" } } },
      updateWarnings: expect.arrayContaining([expect.stringContaining("local password fallback")]),
    });
  }
});

it.each(["repair", "generate", "backup failure", "replacement", "kind change"] as const)(
  "settles managed token repair after %s",
  async (change) => {
    const kind = change === "generate" ? "env" : "secret";
    const { ctx, entry, run, backups } = await createFixture(
      REDACTED_SENTINEL,
      change === "generate" ? { generateGatewayToken: true } : { repair: true },
      kind,
    );
    if (change !== "repair" && change !== "generate") {
      const snapshot = sqliteSnapshot.createVerifiedSqliteSnapshot;
      const backup = vi.spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot");
      if (change === "backup failure") {
        backup.mockRejectedValueOnce(new Error("synthetic disk full"));
      } else {
        backup.mockImplementationOnce(async (options) => {
          const result = await snapshot(options);
          if (change === "replacement") {
            await writeToken({
              ...entry,
              kind: "secret",
              value: "synthetic-concurrent-replacement",
              updatedBy: "concurrent-writer",
            });
          } else {
            openStateDb(entry.database)
              .db.prepare(
                "UPDATE secret_store_entries SET kind = 'env', allowed_hosts = NULL WHERE name = ?",
              )
              .run(tokenRef.id);
          }
          return result;
        });
      }
    }
    await run();
    if (change === "backup failure" || change === "replacement") {
      expect(await readToken(entry)).toEqual({
        ok: true,
        value: change === "replacement" ? "synthetic-concurrent-replacement" : REDACTED_SENTINEL,
      });
      expect(ctx.updateWarnings).toContainEqual(
        expect.stringContaining(change === "replacement" ? tokenRef.id : "synthetic disk full"),
      );
      if (change === "backup failure") {
        expect(backups()).toEqual([]);
      }
      return;
    }
    const repaired = await readToken(entry);
    const finalKind = change === "kind change" ? "env" : kind;
    expect(repaired).toEqual({ ok: true, value: expect.stringMatching(/^[a-f0-9]{48}$/u) });
    expect(ctx.cfg.gateway?.auth?.token).toEqual(tokenRef);
    expect(await detectGatewayAuthHealth(ctx)).toEqual([]);
    expect(await listEntries(entry)).toEqual([
      expect.objectContaining({
        kind: finalKind,
        ...(finalKind === "secret" ? { allowedHosts: ["gateway.example.test"] } : {}),
      }),
    ]);
    const exec = await readExecEnv({ includeSecretSentinels: false, database: entry.database });
    expect(exec.env?.[tokenRef.id]).toBe(
      finalKind === "env" && repaired.ok ? repaired.value : undefined,
    );
    const backup = expectDefined(backups()[0], "verified Gateway token backup");
    expect(backups()).toHaveLength(1);
    expect(await readToken({ ...entry, database: { path: backup } })).toEqual({
      ok: true,
      value: REDACTED_SENTINEL,
    });
    expectNote("re-pair");
    expectNote(backup);
  },
);
