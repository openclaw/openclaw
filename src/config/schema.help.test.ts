import { describe, expect, it } from "vitest";
import { FIELD_HELP } from "./schema.help.js";

describe("FIELD_HELP", () => {
  describe("structure", () => {
    it("is a non-null object", () => {
      expect(FIELD_HELP).toBeDefined();
      expect(typeof FIELD_HELP).toBe("object");
      expect(FIELD_HELP).not.toBeNull();
    });

    it("has string keys and string values throughout", () => {
      for (const [key, value] of Object.entries(FIELD_HELP)) {
        expect(typeof key).toBe("string");
        expect(typeof value).toBe("string");
        expect(key.length).toBeGreaterThan(0);
      }
    });

    it("has no empty help strings", () => {
      for (const [key, value] of Object.entries(FIELD_HELP)) {
        expect(value.trim().length, `FIELD_HELP["${key}"] must not be empty`).toBeGreaterThan(0);
      }
    });

    it("contains a substantial number of entries covering major subsystems", () => {
      expect(Object.keys(FIELD_HELP).length).toBeGreaterThan(100);
    });
  });

  describe("top-level subsystem keys", () => {
    const topLevelKeys = [
      "meta",
      "env",
      "wizard",
      "diagnostics",
      "logging",
      "cli",
      "update",
      "gateway",
      "agents",
      "browser",
      "tools",
      "channels",
      "session",
      "cron",
      "hooks",
      "plugins",
      "models",
      "auth",
      "memory",
      "ui",
    ];

    for (const key of topLevelKeys) {
      it(`includes a description for top-level key "${key}"`, () => {
        expect(FIELD_HELP).toHaveProperty(key);
        expect(typeof FIELD_HELP[key]).toBe("string");
        expect(FIELD_HELP[key].length).toBeGreaterThan(10);
      });
    }
  });

  describe("gateway sub-keys", () => {
    it("has help text for gateway.port", () => {
      expect(FIELD_HELP["gateway.port"]).toMatch(/port/i);
    });

    it("has help text for gateway.mode", () => {
      expect(FIELD_HELP["gateway.mode"]).toMatch(/local|remote/i);
    });

    it("has help text for gateway.auth.mode listing valid options", () => {
      const text = FIELD_HELP["gateway.auth.mode"];
      expect(text).toMatch(/token|password|none/i);
    });

    it("has help text for gateway.tls.enabled", () => {
      expect(FIELD_HELP["gateway.tls.enabled"]).toMatch(/tls|https/i);
    });

    it("has help text for gateway.reload.mode listing all modes", () => {
      const text = FIELD_HELP["gateway.reload.mode"];
      expect(text).toMatch(/hot|restart|hybrid/i);
    });
  });

  describe("logging sub-keys", () => {
    it("has help text for logging.level that lists valid level names", () => {
      const text = FIELD_HELP["logging.level"];
      expect(text).toMatch(/debug|info|warn|error/i);
    });

    it("has help text for logging.consoleStyle listing format options", () => {
      const text = FIELD_HELP["logging.consoleStyle"];
      expect(text).toMatch(/pretty|compact|json/i);
    });

    it("has help text for logging.redactSensitive", () => {
      expect(FIELD_HELP["logging.redactSensitive"]).toMatch(/redact|sensitive|mask/i);
    });
  });

  describe("tools sub-keys", () => {
    it("has help text for tools.exec.security", () => {
      expect(FIELD_HELP["tools.exec.security"]).toMatch(/sandbox|security|exec/i);
    });

    it("has help text for tools.web.search.enabled", () => {
      expect(FIELD_HELP["tools.web.search.enabled"]).toMatch(/search|web/i);
    });

    it("has help text for tools.web.fetch.enabled", () => {
      expect(FIELD_HELP["tools.web.fetch.enabled"]).toMatch(/fetch|web/i);
    });

    it("has help text for tools.elevated.enabled", () => {
      expect(FIELD_HELP["tools.elevated.enabled"]).toMatch(/elevated|privileged|trusted/i);
    });

    it("has help for loop detection keys", () => {
      expect(FIELD_HELP["tools.loopDetection.enabled"]).toBeDefined();
      expect(FIELD_HELP["tools.loopDetection.historySize"]).toBeDefined();
      expect(FIELD_HELP["tools.loopDetection.criticalThreshold"]).toBeDefined();
    });
  });

  describe("agents sub-keys", () => {
    it("has help text for agents.defaults", () => {
      expect(FIELD_HELP["agents.defaults"]).toBeDefined();
    });

    it("has help text for agents.list", () => {
      expect(FIELD_HELP["agents.list"]).toBeDefined();
    });

    it("has help text for agents.defaults.memorySearch.enabled", () => {
      expect(FIELD_HELP["agents.defaults.memorySearch.enabled"]).toMatch(/memory|search|recall/i);
    });

    it("has help text for agents.defaults.compaction.mode", () => {
      expect(FIELD_HELP["agents.defaults.compaction.mode"]).toBeDefined();
    });

    it("has help text for per-agent heartbeat policy keys", () => {
      expect(FIELD_HELP["agents.defaults.heartbeat.suppressToolErrorWarnings"]).toBeDefined();
      expect(FIELD_HELP["agents.list[].heartbeat.suppressToolErrorWarnings"]).toBeDefined();
    });
  });

  describe("channels sub-keys", () => {
    it("has help text for channels.telegram.botToken", () => {
      expect(FIELD_HELP["channels.telegram.botToken"]).toMatch(/token|telegram/i);
    });

    it("has help text for channels.discord.token", () => {
      expect(FIELD_HELP["channels.discord.token"]).toMatch(/token|discord/i);
    });

    it("has help text for channels.slack.botToken", () => {
      expect(FIELD_HELP["channels.slack.botToken"]).toMatch(/token|slack/i);
    });

    it("has help text for dm policy across providers", () => {
      expect(FIELD_HELP["channels.telegram.dmPolicy"]).toBeDefined();
      expect(FIELD_HELP["channels.discord.dmPolicy"]).toBeDefined();
      expect(FIELD_HELP["channels.whatsapp.dmPolicy"]).toBeDefined();
      expect(FIELD_HELP["channels.signal.dmPolicy"]).toBeDefined();
    });

    it("has help text for channels.discord streaming mode", () => {
      expect(FIELD_HELP["channels.discord.streaming"]).toMatch(/stream|partial|block/i);
    });

    it("has help text for channels.defaults.groupPolicy", () => {
      expect(FIELD_HELP["channels.defaults.groupPolicy"]).toMatch(/open|disabled|allowlist/i);
    });
  });

  describe("session sub-keys", () => {
    it("has help text for session.scope", () => {
      expect(FIELD_HELP["session.scope"]).toMatch(/per-sender|global/i);
    });

    it("has help text for session.reset.mode", () => {
      expect(FIELD_HELP["session.reset.mode"]).toMatch(/daily|idle/i);
    });

    it("has help text for session.maintenance.mode", () => {
      expect(FIELD_HELP["session.maintenance.mode"]).toMatch(/warn|enforce/i);
    });

    it("has help text for session.sendPolicy", () => {
      expect(FIELD_HELP["session.sendPolicy"]).toBeDefined();
    });
  });

  describe("cron sub-keys", () => {
    it("has help text for cron.enabled", () => {
      expect(FIELD_HELP["cron.enabled"]).toMatch(/cron|job|schedule/i);
    });

    it("has help text for cron.maxConcurrentRuns", () => {
      expect(FIELD_HELP["cron.maxConcurrentRuns"]).toMatch(/concurrent|parallel|job/i);
    });

    it("has help text for cron.sessionRetention", () => {
      expect(FIELD_HELP["cron.sessionRetention"]).toBeDefined();
    });
  });

  describe("models sub-keys", () => {
    it("has help text for models.mode describing merge vs replace", () => {
      expect(FIELD_HELP["models.mode"]).toMatch(/merge|replace/i);
    });

    it("has help text for models.providers.*.apiKey", () => {
      expect(FIELD_HELP["models.providers.*.apiKey"]).toMatch(/api.?key|credential|auth/i);
    });

    it("has help text for Bedrock discovery", () => {
      expect(FIELD_HELP["models.bedrockDiscovery.enabled"]).toBeDefined();
      expect(FIELD_HELP["models.bedrockDiscovery.region"]).toBeDefined();
    });
  });

  describe("hooks sub-keys", () => {
    it("has help text for hooks.enabled", () => {
      expect(FIELD_HELP["hooks.enabled"]).toMatch(/hook|webhook|endpoint/i);
    });

    it("has help text for hooks.token", () => {
      expect(FIELD_HELP["hooks.token"]).toMatch(/token|auth|bearer/i);
    });

    it("has help text for hooks.mappings", () => {
      expect(FIELD_HELP["hooks.mappings"]).toBeDefined();
    });

    it("has help text for hooks.gmail keys", () => {
      expect(FIELD_HELP["hooks.gmail"]).toBeDefined();
      expect(FIELD_HELP["hooks.gmail.account"]).toBeDefined();
      expect(FIELD_HELP["hooks.gmail.topic"]).toBeDefined();
    });
  });

  describe("plugins sub-keys", () => {
    it("has help text for plugins.enabled", () => {
      expect(FIELD_HELP["plugins.enabled"]).toMatch(/plugin|extension/i);
    });

    it("has help text for plugins.allow and plugins.deny", () => {
      expect(FIELD_HELP["plugins.allow"]).toBeDefined();
      expect(FIELD_HELP["plugins.deny"]).toBeDefined();
    });

    it("has help text for plugins.slots.memory", () => {
      expect(FIELD_HELP["plugins.slots.memory"]).toBeDefined();
    });
  });

  describe("meta keys", () => {
    it("has help text for meta field", () => {
      expect(FIELD_HELP["meta"]).toMatch(/metadata|version|history/i);
    });

    it("has help text for meta.lastTouchedVersion", () => {
      expect(FIELD_HELP["meta.lastTouchedVersion"]).toBeDefined();
    });

    it("has help text for meta.lastTouchedAt", () => {
      expect(FIELD_HELP["meta.lastTouchedAt"]).toMatch(/timestamp|ISO|time/i);
    });
  });

  describe("diagnostics sub-keys", () => {
    it("has help text for diagnostics.otel.enabled", () => {
      expect(FIELD_HELP["diagnostics.otel.enabled"]).toMatch(/otel|telemetry|export/i);
    });

    it("has help text for diagnostics.cacheTrace.enabled", () => {
      expect(FIELD_HELP["diagnostics.cacheTrace.enabled"]).toBeDefined();
    });

    it("has help text for diagnostics.flags", () => {
      expect(FIELD_HELP["diagnostics.flags"]).toBeDefined();
    });
  });
});
