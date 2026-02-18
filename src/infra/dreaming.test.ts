import { describe, it, expect } from "vitest";
import {
  buildDreamingPrompt,
  buildDreamingCronJob,
  shouldDream,
  resolveDreamingConfig,
  DREAMING_DEFAULTS,
  type DreamingConfig,
} from "./dreaming.js";

describe("dreaming", () => {
  describe("resolveDreamingConfig", () => {
    it("returns defaults when no config provided", () => {
      const config = resolveDreamingConfig(undefined);
      expect(config.enabled).toBe(true);
      expect(config.schedule).toBe("0 3 * * *");
      expect(config.model).toBe("auto");
      expect(config.lookbackDays).toBe(7);
      expect(config.mode).toBe("consolidate");
      expect(config.quietMinutes).toBe(60);
    });

    it("merges partial config with defaults", () => {
      const config = resolveDreamingConfig({
        enabled: false,
        mode: "reflect",
      });
      expect(config.enabled).toBe(false);
      expect(config.mode).toBe("reflect");
      expect(config.schedule).toBe("0 3 * * *"); // default
      expect(config.lookbackDays).toBe(7); // default
    });

    it("resolves delivery config", () => {
      const config = resolveDreamingConfig({
        delivery: {
          enabled: true,
          channel: "whatsapp",
          to: "+1234567890",
        },
      });
      expect(config.delivery?.enabled).toBe(true);
      expect(config.delivery?.channel).toBe("whatsapp");
      expect(config.delivery?.to).toBe("+1234567890");
    });
  });

  describe("buildDreamingPrompt", () => {
    it("generates consolidate prompt", () => {
      const prompt = buildDreamingPrompt(DREAMING_DEFAULTS);
      expect(prompt).toContain("Dreaming Process");
      expect(prompt).toContain("Memory Consolidation");
      expect(prompt).toContain("MEMORY.md");
      expect(prompt).toContain("7"); // lookbackDays
    });

    it("generates reflect prompt with pattern analysis", () => {
      const config: DreamingConfig = { ...DREAMING_DEFAULTS, mode: "reflect" };
      const prompt = buildDreamingPrompt(config);
      expect(prompt).toContain("Reflection");
      expect(prompt).toContain("Analyze patterns");
    });

    it("generates organize prompt with workspace cleanup", () => {
      const config: DreamingConfig = { ...DREAMING_DEFAULTS, mode: "organize" };
      const prompt = buildDreamingPrompt(config);
      expect(prompt).toContain("Organization");
      expect(prompt).toContain("workspace files");
    });
  });

  describe("buildDreamingCronJob", () => {
    it("creates valid cron job definition", () => {
      const job = buildDreamingCronJob(DREAMING_DEFAULTS, "Europe/Lisbon");
      expect(job.name).toContain("Dreaming");
      expect(job.schedule.kind).toBe("cron");
      expect(job.schedule.expr).toBe("0 3 * * *");
      expect(job.schedule.tz).toBe("Europe/Lisbon");
      expect(job.sessionTarget).toBe("isolated");
      expect(job.payload.kind).toBe("agentTurn");
      expect(job.delivery.mode).toBe("none");
    });

    it("uses announce delivery when configured", () => {
      const config: DreamingConfig = {
        ...DREAMING_DEFAULTS,
        delivery: { enabled: true, channel: "whatsapp", to: "+1234567890" },
      };
      const job = buildDreamingCronJob(config);
      expect(job.delivery.mode).toBe("announce");
    });

    it("respects custom model", () => {
      const config: DreamingConfig = { ...DREAMING_DEFAULTS, model: "haiku" };
      const job = buildDreamingCronJob(config);
      expect(job.payload.model).toBe("haiku");
    });

    it("omits model when set to auto", () => {
      const job = buildDreamingCronJob(DREAMING_DEFAULTS);
      expect(job.payload.model).toBeUndefined();
    });
  });

  describe("shouldDream", () => {
    it("returns true when no activity recorded", () => {
      expect(shouldDream(undefined, 60)).toBe(true);
    });

    it("returns true when user has been quiet long enough", () => {
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      expect(shouldDream(twoHoursAgo, 60)).toBe(true);
    });

    it("returns false when user was recently active", () => {
      const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
      expect(shouldDream(tenMinutesAgo, 60)).toBe(false);
    });

    it("respects custom quiet minutes", () => {
      const twentyMinutesAgo = Date.now() - 20 * 60 * 1000;
      expect(shouldDream(twentyMinutesAgo, 15)).toBe(true);
      expect(shouldDream(twentyMinutesAgo, 30)).toBe(false);
    });
  });
});
