import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import type { CronJob } from "../../../../src/cron/types.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

// Controlled provider; Gateway, scheduler, runtime admission, exec and CLI auth are real.
describe("native command recovery Gateway authority", () => {
  it(
    "executes authorized evidence under the same host trust as an ordinary operator automation",
    { timeout: 180_000 },
    async () => {
      const owner = createQaLiveLaneGateway();
      try {
        const { gateway, mock } = await owner.start({
          repoRoot: process.cwd(),
          providerMode: "mock-openai",
          primaryModel: "mock-openai/gpt-5.6-luna",
          alternateModel: "mock-openai/gpt-5.6-luna-alt",
          transport: { requiredPluginIds: [], createGatewayConfig: () => ({}) },
          transportBaseUrl: "http://127.0.0.1",
          controlUiEnabled: false,
          mutateConfig: (cfg) => ({
            ...cfg,
            cron: { ...cfg.cron, enabled: true },
            tools: {
              ...cfg.tools,
              profile: "coding",
              exec: { host: "gateway", security: "full", ask: "off" },
            },
          }),
        });
        // Gateway readiness precedes asynchronous cron startup. Create the
        // failure only after catch-up ends, so it is ordinary scheduled work.
        await vi.waitFor(
          async () => {
            const logsDir = path.join(gateway.workspaceDir, "logs");
            const names = (await fs.readdir(logsDir)).filter((name) => name.endsWith(".log"));
            const logs = await Promise.all(
              names.map((name) => fs.readFile(path.join(logsDir, name), "utf8")),
            );
            expect(logs.some((text) => text.includes('"cron: started"'))).toBe(true);
          },
          { timeout: 30_000, interval: 100 },
        );
        const marker = `EVIDENCE_${randomUUID()}`;
        const evidencePath = path.join(gateway.workspaceDir, "authorized-evidence.txt");
        const authorityPath = path.join(gateway.workspaceDir, "authority-result.txt");
        await fs.writeFile(evidencePath, marker);
        const parent = (await gateway.call("cron.add", {
          name: "failure fixture",
          agentId: "qa",
          enabled: false,
          schedule: { kind: "every", everyMs: 3_600_000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "command", argv: ["sh", "-c", "exit 23"] },
          delivery: { mode: "none" },
          failureAlert: false,
        })) as CronJob;
        const targetId = parent.id;
        const params = JSON.stringify({ id: targetId, patch: { enabled: false } });
        const command = `cat ${JSON.stringify(evidencePath)}; node ${JSON.stringify(path.join(process.cwd(), "openclaw.mjs"))} gateway call cron.update --params '${params}' --json > ${JSON.stringify(authorityPath)} 2>&1`;
        const message = `Tool progress QA check: call the exec tool exactly once with this exact command before answering: \`${command}\`. After that command completes, reply exactly \`RECOVERY_FINISHED\`.`;
        await gateway.call("cron.update", {
          id: parent.id,
          patch: {
            enabled: true,
            failureRecovery: { agentId: "qa", message, toolsAllow: ["exec"], timeoutSeconds: 90 },
          },
        });
        await gateway.call("cron.run", { id: parent.id, mode: "force", waitTimeoutMs: 30_000 });
        let child: CronJob | undefined;
        const deadline = Date.now() + 100_000;
        while (Date.now() < deadline) {
          const current = (await gateway.call("cron.get", { id: parent.id })) as CronJob;
          if (current.state.failureRecovery) {
            child = (await gateway.call("cron.get", {
              id: current.state.failureRecovery.jobId,
            })) as CronJob;
            if (
              child.state.commandRecoveryOrigin?.startedAtMs !== undefined &&
              child.state.lastRunStatus
            ) {
              break;
            }
          }
          await sleep(100);
        }
        expect(child?.state.commandRecoveryOrigin?.startedAtMs).toBeDefined();
        expect(child?.state.lastRunStatus).toBe("ok");
        expect(child?.delivery).toMatchObject({ mode: "none" });
        const childRuns = await gateway.call("cron.runs", { id: child!.id });
        expect(JSON.stringify(childRuns)).toContain(child!.id);
        if (!mock) {
          throw new Error("missing deterministic provider");
        }
        const requests = await fetch(`${mock.baseUrl}/debug/requests`).then((response) =>
          response.json(),
        );
        expect(JSON.stringify(requests)).toContain(marker);
        const authority = await fs.readFile(authorityPath, "utf8");
        expect(authority).toContain(targetId);
        const recoveryEnabled = ((await gateway.call("cron.get", { id: parent.id })) as CronJob)
          .enabled;
        // Unsandboxed host exec intentionally belongs to operator trust. Compare
        // the ordinary scheduled path instead of claiming a hostile-user boundary.
        await gateway.call("cron.update", { id: parent.id, patch: { enabled: true } });
        await fs.rm(authorityPath);
        const ordinary = (await gateway.call("cron.add", {
          name: "ordinary operator authority comparison",
          agentId: "qa",
          enabled: false,
          schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message, toolsAllow: ["exec"], timeoutSeconds: 90 },
          delivery: { mode: "none" },
          deleteAfterRun: false,
        })) as CronJob;
        await gateway.call("cron.run", { id: ordinary.id, mode: "force", waitTimeoutMs: 100_000 });
        expect(await fs.readFile(authorityPath, "utf8")).toContain(targetId);
        expect(((await gateway.call("cron.get", { id: parent.id })) as CronJob).enabled).toBe(
          recoveryEnabled,
        );
        await gateway.restart();
        const replay = await gateway.call("cron.run", {
          id: child!.id,
          mode: "force",
          waitTimeoutMs: 30_000,
        });
        expect(replay).toMatchObject({ ok: true, ran: false, reason: "not-due" });
        const reread = (await gateway.call("cron.get", { id: child!.id })) as CronJob;
        expect(reread.state.commandRecoveryOrigin?.startedAtMs).toBe(
          child!.state.commandRecoveryOrigin?.startedAtMs,
        );
      } finally {
        await stopQaGatewayFixture(owner);
      }
    },
  );
});
