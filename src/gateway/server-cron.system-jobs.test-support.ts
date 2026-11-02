import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronFixture } from "./server-cron.context.test-support.js";

export function registerGatewayCronSystemJobTests({
  createCronConfig,
  withCronService,
  setRuntimeConfig,
}: {
  createCronConfig: (name: string) => OpenClawConfig;
  withCronService: (
    cfg: OpenClawConfig,
    run: (state: CronFixture) => Promise<void>,
  ) => Promise<void>;
  setRuntimeConfig: (cfg: OpenClawConfig) => void;
}) {
  it("never recreates a deleted automation during Gateway startup or config reload", async () => {
    const cfg = createCronConfig("server-cron-no-monitor-reprovision");
    await withCronService(cfg, async (state) => {
      await state.cron.start();
      expect(await state.cron.list({ includeDisabled: true })).toEqual([]);
      const job = await state.cron.add({
        name: "Migrated proactive work",
        enabled: false,
        schedule: { kind: "every", everyMs: 3_600_000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Review outstanding work" },
        delivery: { mode: "none" },
      });
      await state.cron.remove(job.id);
      await state.cron.stopAndDrain?.();
      setRuntimeConfig({ ...cfg, agents: { ...cfg.agents, defaults: { model: "fixture/model" } } });
      await state.cron.start();
      expect(await state.cron.list({ includeDisabled: true })).toEqual([]);
    });
  });
}
