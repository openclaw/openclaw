import { describe, expect, it } from "vitest";
import { classifyDiskArtifact, classifySessionKeyForHealth } from "./session-health-classify.js";

describe("classifySessionKeyForHealth", () => {
  describe("main sessions", () => {
    it("classifies agent:main:main as main", () => {
      expect(classifySessionKeyForHealth("agent:main:main")).toBe("main");
    });

    it("classifies agent:main:default as main", () => {
      expect(classifySessionKeyForHealth("agent:main:default")).toBe("main");
    });

    it("classifies agent:adx:main as main", () => {
      expect(classifySessionKeyForHealth("agent:adx:main")).toBe("main");
    });

    it("classifies custom mainKey as main", () => {
      expect(classifySessionKeyForHealth("agent:main:custom-key")).toBe("main");
    });
  });

  describe("cron sessions", () => {
    it("classifies cron run instances", () => {
      expect(classifySessionKeyForHealth("agent:main:cron:daily-check:run:abc123")).toBe(
        "cron-run",
      );
    });

    it("classifies cron definition keys", () => {
      expect(classifySessionKeyForHealth("agent:main:cron:daily-check")).toBe("cron-definition");
    });

    it("does not confuse cron-definition with cron-run", () => {
      expect(classifySessionKeyForHealth("agent:main:cron:my-job")).toBe("cron-definition");
      expect(classifySessionKeyForHealth("agent:main:cron:my-job:run:1")).toBe("cron-run");
    });
  });

  describe("subagent sessions", () => {
    it("classifies agent-scoped subagent keys", () => {
      expect(classifySessionKeyForHealth("agent:main:subagent:abc123-def456")).toBe("subagent");
    });

    it("classifies deeply nested subagent keys", () => {
      expect(classifySessionKeyForHealth("agent:main:subagent:abc:subagent:def")).toBe("subagent");
    });
  });

  describe("acp sessions", () => {
    it("classifies agent-scoped acp keys", () => {
      expect(classifySessionKeyForHealth("agent:main:acp:session-123")).toBe("acp");
    });

    it("classifies bare acp keys", () => {
      expect(classifySessionKeyForHealth("acp:session-123")).toBe("acp");
    });
  });

  describe("heartbeat sessions", () => {
    it("classifies heartbeat keys", () => {
      expect(classifySessionKeyForHealth("agent:main:heartbeat:wake-123")).toBe("heartbeat");
    });
  });

  describe("thread sessions", () => {
    it("classifies thread keys", () => {
      expect(classifySessionKeyForHealth("agent:main:discord:group:123:thread:456")).toBe("thread");
    });

    it("classifies topic keys as thread", () => {
      expect(classifySessionKeyForHealth("agent:main:discord:group:123:topic:456")).toBe("thread");
    });
  });

  describe("channel/group sessions", () => {
    it("classifies group keys", () => {
      expect(classifySessionKeyForHealth("agent:main:discord:group:123456")).toBe("channel");
    });

    it("classifies channel keys", () => {
      expect(classifySessionKeyForHealth("agent:main:telegram:channel:789")).toBe("channel");
    });
  });

  describe("direct sessions", () => {
    it("classifies per-peer direct keys", () => {
      expect(classifySessionKeyForHealth("agent:main:direct:+15551234567")).toBe("direct");
    });

    it("classifies per-channel-peer direct keys", () => {
      expect(classifySessionKeyForHealth("agent:main:telegram:direct:12345")).toBe("direct");
    });
  });

  describe("unknown sessions", () => {
    it("returns unknown for empty string", () => {
      expect(classifySessionKeyForHealth("")).toBe("unknown");
    });

    it("returns unknown for null/undefined", () => {
      expect(classifySessionKeyForHealth(null)).toBe("unknown");
      expect(classifySessionKeyForHealth(undefined)).toBe("unknown");
    });

    it("returns unknown for legacy non-agent keys", () => {
      expect(classifySessionKeyForHealth("global")).toBe("unknown");
    });

    it("returns unknown for unrecognized agent-scoped keys with colons", () => {
      // agent:main:some:weird:key - has colons in rest, doesn't match any pattern
      // This would currently fall to unknown because rest contains ':'
      // but doesn't match any known pattern.
      expect(classifySessionKeyForHealth("agent:main:some:weird:key")).toBe("unknown");
    });
  });

  describe("case insensitivity", () => {
    it("handles mixed case in cron keys", () => {
      expect(classifySessionKeyForHealth("Agent:Main:Cron:test:Run:123")).toBe("cron-run");
    });

    it("handles mixed case in subagent keys", () => {
      expect(classifySessionKeyForHealth("Agent:Main:Subagent:abc")).toBe("subagent");
    });
  });
});

describe("classifyDiskArtifact", () => {
  describe("index files", () => {
    it("classifies sessions.json as index", () => {
      expect(classifyDiskArtifact("sessions.json")).toBe("index");
    });
  });

  describe("backup files", () => {
    it("classifies sessions.json.backup as backup", () => {
      expect(classifyDiskArtifact("sessions.json.backup")).toBe("backup");
    });

    it("classifies rotation backups as backup", () => {
      expect(classifyDiskArtifact("sessions.json.bak.1679012345")).toBe("backup");
    });
  });

  describe("orphaned temp files", () => {
    it("classifies .tmp files as orphanedTemp", () => {
      expect(classifyDiskArtifact("sessions.json.abc123.tmp")).toBe("orphanedTemp");
    });

    it("classifies any .tmp suffix as orphanedTemp", () => {
      expect(classifyDiskArtifact("something.tmp")).toBe("orphanedTemp");
    });
  });

  describe("deleted transcript files", () => {
    it("classifies .deleted.* files", () => {
      expect(classifyDiskArtifact("abc-123.jsonl.deleted.1679012345")).toBe("deleted");
    });
  });

  describe("reset transcript files", () => {
    it("classifies .reset.* files", () => {
      expect(classifyDiskArtifact("abc-123.jsonl.reset.1679012345")).toBe("reset");
    });
  });

  describe("active transcript files", () => {
    it("classifies .jsonl files as active", () => {
      expect(classifyDiskArtifact("abc-123.jsonl")).toBe("active");
    });

    it("classifies any other file as active", () => {
      expect(classifyDiskArtifact("random-file.txt")).toBe("active");
    });
  });

  describe("edge cases", () => {
    it("classifies empty string as active", () => {
      expect(classifyDiskArtifact("")).toBe("active");
    });
  });
});
