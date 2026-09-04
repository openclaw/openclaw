import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { completeGatewayBootLifecycle } from "../../src/infra/gateway-boot-lifecycle.js";
import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../src/infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.js";
import { listKnownProviderAuthEnvVarNames } from "../../src/secrets/provider-env-vars.js";
import type { DB } from "../../src/state/openclaw-state-db.generated.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { createOpenClawTestInstance } from "../helpers/openclaw-test-instance.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";

describe("built Gateway readiness ownership", () => {
  it.each(["none", "password", "trusted-proxy"] as const)(
    "readies the owned Gateway after the fixture rewrites auth to %s",
    async (mode) => {
      const instance = await createOpenClawTestInstance({
        name: `readiness-${mode}`,
        env: Object.fromEntries(
          [...listKnownProviderAuthEnvVarNames(), "CODEX_THREAD_ID"].map((key) => [key, undefined]),
        ),
      });
      try {
        await instance.state.writeConfig({
          gateway: {
            mode: "local",
            port: instance.port,
            trustedProxies: ["127.0.0.1", "::1"],
            auth: {
              mode,
              password: "synthetic-direct-local-password",
              ...(mode === "trusted-proxy"
                ? { trustedProxy: { userHeader: "x-forwarded-user", allowLoopback: true } }
                : {}),
            },
            controlUi: { enabled: false },
          },
          plugins: { enabled: false },
        });
        await instance.startGateway();
        const pid = instance.child?.pid;
        if (!pid) {
          throw new Error("ready Gateway has no child PID");
        }
        const db = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(instance.env), {
          readOnly: true,
        });
        let bootId: string;
        try {
          const boot = executeSqliteQueryTakeFirstSync(
            db,
            getNodeSqliteKysely<Pick<DB, "gateway_boot_lifecycle">>(db)
              .selectFrom("gateway_boot_lifecycle")
              .select("boot_id")
              .where("pid", "=", pid)
              .where("completed_at_ms", "is", null),
          );
          if (!boot) {
            throw new Error("ready Gateway has no recorded boot");
          }
          bootId = boot.boot_id;
        } finally {
          db.close();
        }
        // Safe-mode recovery closes a diagnostic segment without replacing the
        // server. Its live connection still identifies this same child and boot.
        completeGatewayBootLifecycle(bootId, { outcome: "safe_mode_stable" }, instance.env);
        await instance.startGateway();
      } finally {
        await instance.cleanup();
      }
      expect(instance.child).toBeUndefined();
      await expect(fs.stat(instance.state.root)).rejects.toMatchObject({ code: "ENOENT" });
    },
    120_000,
  );

  it("rejects a refused child while another real Gateway serves its released port", async () => {
    const env = Object.fromEntries(
      [...listKnownProviderAuthEnvVarNames(), "CODEX_THREAD_ID"].map((key) => [key, undefined]),
    );
    const candidate = await createOpenClawTestInstance({
      name: "readiness-refused-child",
      gatewayToken: "shared-synthetic-readiness-token",
      env: { ...env, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      config: { gateway: { mode: "local" }, plugins: { enabled: false } },
      startTimeoutMs: 90_000,
    });
    const instances = [candidate];
    try {
      const foreign = await createOpenClawTestInstance({
        name: "readiness-foreign-listener",
        port: candidate.port,
        gatewayToken: candidate.gatewayToken,
        env,
        config: { gateway: { mode: "local" }, plugins: { enabled: false } },
      });
      instances.push(foreign);
      const legacy = JSON.stringify({ main: { sessionId: "legacy", updatedAt: 1 } });
      const transcript = '{"type":"message","message":{"role":"user","content":"preserved"}}\n';
      const legacyPath = await candidate.state.writeText("sessions/sessions.json", legacy);
      const transcriptPath = await candidate.state.writeText("sessions/legacy.jsonl", transcript);
      expect(await candidate.entrypoint()).toEqual([
        expect.stringMatching(/^dist\/index\.(?:js|mjs)$/u),
      ]);
      expect(await foreign.entrypoint()).toEqual(await candidate.entrypoint());
      expect(candidate.port).not.toBe(18789);
      await foreign.startGateway();
      const foreignPid = foreign.child?.pid;
      if (!foreignPid) {
        throw new Error("ready Gateway has no child PID");
      }
      const failure = await candidate.startGateway().then(
        () => undefined,
        (error: unknown) => error,
      );
      if (!(failure instanceof Error)) {
        throw new Error("readiness must belong to the admitted child, not the foreign Gateway");
      }
      expect(failure.message).toContain("gateway exited before readiness (code=1 signal=null)");
      expect(failure.message).toContain(
        `Legacy session store requires migration: ${legacyPath}. Run "openclaw doctor --fix"`,
      );
      expect(await fs.readFile(legacyPath, "utf8")).toBe(legacy);
      expect(await fs.readFile(transcriptPath, "utf8")).toBe(transcript);
      expect(isProcessAlive(foreignPid)).toBe(true);
      const response = await fetch(`http://127.0.0.1:${foreign.port}/readyz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ready: true });
    } finally {
      await runQaGatewayFixture(
        () => candidate.cleanup(),
        ...instances.slice(1).map((instance) => () => instance.cleanup()),
      );
    }
    for (const instance of instances) {
      expect(instance.child).toBeUndefined();
      await expect(fs.stat(instance.state.root)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }, 120_000);
});
