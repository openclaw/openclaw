import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { tryListenOnPort } from "../../infra/ports-probe.js";
import { createManagedUpdateRequesterAuthority } from "../../infra/update-requester-authority.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  repairIsolationConfig,
  repairIsolationProvider,
  writeRepairCandidate,
} from "./update-command-repair-isolation.test-support.js";
import { runUpdateCommandRepair } from "./update-command-repair.js";

// Keep source orchestration while using the built snapshot worker as packaged updates do.
vi.mock("../../infra/runtime-worker-url.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/runtime-worker-url.js")>();
  return {
    ...actual,
    resolveRuntimeWorkerUrl: (params: Parameters<typeof actual.resolveRuntimeWorkerUrl>[0]) =>
      actual.resolveRuntimeWorkerUrl(
        params.sourceWorkerName === "update-candidate-state.worker"
          ? { ...params, root: process.cwd() }
          : params,
      ),
  };
});

type RepairProof = {
  stateDir: string;
  configPath: string;
  workspaceDir: string;
  cwd: string;
  before: string;
  doctor?: { status: number; output?: string; error?: string };
};

async function fileIdentity(file: string) {
  const stat = await fs.stat(file, { bigint: true });
  return { bytes: await fs.readFile(file), inode: stat.ino, modified: stat.mtimeNs };
}

describe("staged CLI repair isolation", () => {
  it.each([
    {
      name: "discards config and doctor repairs without changing serving files",
      configChange: true,
      revokeRequester: false,
      revokeAfterValidation: false,
    },
    {
      name: "keeps candidate-root repairs eligible for activation",
      configChange: false,
      revokeRequester: false,
      revokeAfterValidation: false,
    },
    {
      name: "honors live requester revocation before a copied-state repair tool runs",
      configChange: false,
      revokeRequester: true,
      revokeAfterValidation: false,
    },
    {
      name: "rejects a rebound requester after successful rehearsal validation",
      configChange: true,
      revokeRequester: false,
      revokeAfterValidation: true,
    },
  ])(
    "$name",
    async ({ configChange, revokeRequester, revokeAfterValidation }) => {
      await withOpenClawTestState(
        {
          prefix: "repair-isolation-",
          layout: "split",
          env: {
            OPENCLAW_GATEWAY_PORT: undefined,
            OPENCLAW_GATEWAY_TOKEN: undefined,
            OPENCLAW_GATEWAY_PASSWORD: undefined,
          },
        },
        async (state) => {
          let requesterRevoked = false;
          const provider = repairIsolationProvider(async () => {
            if (revokeRequester) {
              const config = JSON.parse(await fs.readFile(state.configPath, "utf8"));
              config.commands.ownerAllowFrom = [];
              await fs.writeFile(state.configPath, JSON.stringify(config));
              requesterRevoked = true;
            }
          });
          await withServer(provider.handle, async (baseUrl) => {
            const gatewayPort = await tryListenOnPort({ port: 0, host: "127.0.0.1" });
            await state.writeConfig({
              ...repairIsolationConfig(baseUrl, gatewayPort),
              commands: { ownerAllowFrom: ["${HOME}"] },
            });
            const requester = { channel: "synthetic", senderId: state.env.HOME };
            const requesterAuthority = await createManagedUpdateRequesterAuthority(
              requester,
              state.env,
            );
            expect(requesterAuthority.isCurrent()).toBe(true);
            const candidate = state.path("candidate");
            await writeRepairCandidate(candidate, configChange);
            // Seed the real schema, then keep committed evidence in an open WAL.
            // The update ledger has its own fixture so its intended writes cannot
            // disguise a write to the serving installation under examination.
            createUpdateRun({ trigger: "cli" }, { env: state.env });
            const databasePath = state.statePath("state", "openclaw.sqlite");
            const database = openNodeSqliteDatabase(databasePath);
            database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
            database.exec(
              "CREATE TABLE isolation_evidence(value TEXT); INSERT INTO isolation_evidence VALUES ('live-uncheckpointed');",
            );
            try {
              const liveFiles = [
                state.configPath,
                databasePath,
                `${databasePath}-wal`,
                `${databasePath}-shm`,
              ];
              const ledgerEnv = { ...state.env, OPENCLAW_STATE_DIR: state.path("ledger") };
              const run = createUpdateRun(
                { trigger: "chat", origin: { requester } },
                { env: ledgerEnv },
              );
              let requesterCurrent = true;
              const updateRun: NonNullable<UpdateCommandOptions["run"]> = {
                runId: run.runId,
                env: ledgerEnv,
                requesterAuthority: revokeAfterValidation
                  ? {
                      requester,
                      isCurrent: () => requesterCurrent && requesterAuthority.isCurrent(),
                    }
                  : requesterAuthority,
              };
              const before = await Promise.all(
                liveFiles.map(async (file) => ({ file, identity: await fileIdentity(file) })),
              );
              expect(before[2]?.identity.bytes.length).toBeGreaterThan(0);
              const oracleTargets: Array<{
                stateDir: string;
                configPath: string;
                workspaceDir: string;
              }> = [];
              let proof: RepairProof | undefined;
              const result = await runUpdateCommandRepair({
                root: state.path("serving-package"),
                candidateRoot: candidate,
                env: state.env,
                run: updateRun,
                phase: "validating",
                result: {
                  status: "error",
                  mode: "npm",
                  reason: "candidate-proof-missing",
                  steps: [],
                  durationMs: 0,
                },
                validate: async (_signal, assertCurrent, rehearsal) => {
                  assertCurrent();
                  // The first oracle follows worker startup and requester registry
                  // preparation. Neither may migrate or touch serving artifacts.
                  for (const { file, identity } of before) {
                    expect(await fileIdentity(file)).toEqual(identity);
                  }
                  if (rehearsal) {
                    oracleTargets.push({
                      stateDir: rehearsal.stateDir,
                      configPath: rehearsal.configPath,
                      workspaceDir: rehearsal.workspaceDir,
                    });
                  }
                  const raw = await fs
                    .readFile(path.join(candidate, "repair-proof.json"), "utf8")
                    .catch((error: unknown) => {
                      if (!hasNodeErrorCode(error, "ENOENT")) {
                        throw error;
                      }
                      return undefined;
                    });
                  if (!raw) {
                    return { ok: false, score: 0, summary: "Candidate repair marker is absent." };
                  }
                  proof = JSON.parse(raw) as RepairProof;
                  if (configChange) {
                    expect(proof.doctor, JSON.stringify(proof.doctor)).toMatchObject({ status: 0 });
                    const copiedConfig: unknown = JSON.parse(
                      await fs.readFile(proof.configPath, "utf8"),
                    );
                    expect(copiedConfig).toMatchObject({
                      meta: { lastTouchedVersion: expect.any(String) },
                      wizard: { lastRunCommand: "doctor" },
                      plugins: { enabled: false },
                    });
                    const copied = openNodeSqliteDatabase(
                      path.join(proof.stateDir, "state", "openclaw.sqlite"),
                    );
                    try {
                      expect(
                        copied.prepare("SELECT value FROM isolation_evidence").get(),
                      ).toMatchObject({
                        value: "repaired-copy",
                      });
                    } finally {
                      copied.close();
                    }
                  }
                  if (revokeAfterValidation) {
                    requesterCurrent = false;
                    updateRun.requesterAuthority = { requester, isCurrent: () => true };
                  }
                  return { ok: true, score: 1, summary: "Candidate repair marker verified." };
                },
              });

              expect(provider.errors).toEqual([]);
              if (revokeRequester) {
                expect(requesterRevoked).toBe(true);
                expect(result).toMatchObject({ status: "aborted", reason: "requester-revoked" });
                expect(oracleTargets).toHaveLength(1);
                await expect(
                  fs.access(path.join(candidate, "repair-proof.json")),
                ).rejects.toMatchObject({
                  code: "ENOENT",
                });
                for (const { file, identity } of before.filter(
                  ({ file: liveFile }) => liveFile !== state.configPath,
                )) {
                  expect(await fileIdentity(file)).toEqual(identity);
                }
                return;
              }
              expect(proof, JSON.stringify(result)).toMatchObject({
                cwd: candidate,
                before: "live-uncheckpointed",
              });
              if (configChange) {
                expect(proof?.doctor, JSON.stringify(proof?.doctor)).toMatchObject({ status: 0 });
              }
              for (const { file, identity: original } of before) {
                const after = await fileIdentity(file);
                const label = path.basename(file);
                expect(after.bytes.equals(original.bytes), `${label} bytes`).toBe(true);
                expect(after.inode, `${label} inode`).toBe(original.inode);
                expect(after.modified, `${label} mtime`).toBe(original.modified);
              }
              expect(oracleTargets).toHaveLength(2);
              const [oracleTarget, nextOracleTarget] = oracleTargets;
              assert(oracleTarget);
              expect(oracleTarget).toEqual(nextOracleTarget);
              expect(proof).toMatchObject(oracleTarget);
              expect(proof?.stateDir).not.toBe(state.stateDir);
              expect(proof?.configPath).not.toBe(state.configPath);
              expect(result, JSON.stringify(result)).toMatchObject(
                revokeAfterValidation
                  ? {
                      status: "aborted",
                      reason: "requester-revoked",
                      attempts: [],
                      finalValidation: {
                        ok: false,
                        score: 0,
                        summary: "Candidate repair marker is absent.",
                      },
                    }
                  : {
                      status: "repaired",
                      finalValidation: { ok: true },
                    },
              );
              const record = getUpdateRun(run.runId, { env: ledgerEnv });
              expect(record?.steps).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    step: "repairing",
                    detail: expect.stringContaining("candidate rehearsal"),
                  }),
                ]),
              );
              expect(record?.repair).toEqual([
                expect.objectContaining({
                  attempt: 1,
                  status: revokeAfterValidation ? "failed" : "succeeded",
                }),
              ]);
              if (revokeAfterValidation) {
                expect(record?.repair[0]?.reason).toBe("requester-revoked");
              }
              await expect(fs.access(oracleTarget.stateDir)).rejects.toMatchObject({
                code: "ENOENT",
              });
              await expect(
                fs.access(path.join(candidate, "repair-proof.json")),
              ).resolves.toBeUndefined();
            } finally {
              database.close();
            }
          });
        },
      );
    },
    120_000,
  );
});
