import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
}));

vi.mock("../../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config/config.js")>();
  return {
    ...actual,
    loadConfig: configMocks.loadConfig,
  };
});

import { patternDetectorHandler } from "./handler.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;

describe("pattern-detector sender-check integration", () => {
  beforeEach(() => {
    configMocks.loadConfig.mockReset();
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
      return;
    }
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  });

  it("prepends sender-check alert before inbound pattern alerts for non-owner senders", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pattern-detector-state-"));
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-pattern-detector-workspace-"),
    );

    process.env.OPENCLAW_STATE_DIR = stateDir;
    configMocks.loadConfig.mockReturnValue({
      hooks: {
        internal: {
          entries: {
            "pattern-detector": {
              enabled: true,
              patterns: [
                {
                  id: "phone",
                  label: "Phone",
                  regex: "\\d{11}",
                  flags: "g",
                  template: "PHONE {{match}}",
                  enabled: true,
                  direction: "inbound",
                },
              ],
              senderCheck: {
                enabled: true,
                ownerNumbers: ["+556996021005"],
                briefingFile: "contacts-briefing.json",
                maxBriefingChars: 800,
                debounceMinutes: 15,
                knownTemplate: "KNOWN {{senderName}} ({{senderNumber}})",
                unknownTemplate: "UNKNOWN {{senderName}} ({{senderNumber}})",
              },
            },
          },
        },
      },
    });

    try {
      const result = await patternDetectorHandler(
        {
          prompt: "Meu numero: 11999998888",
          senderMetadata: {
            senderE164: "+5511988887777",
            senderName: "Caio",
            senderIsOwner: false,
            sessionKey: "chat:caio",
          },
        },
        {
          agentId: "agent-main",
          workspaceDir,
        },
      );

      expect(result).toBeDefined();
      expect(result?.prependContext).toBeDefined();

      const lines = result?.prependContext?.split("\n") ?? [];
      expect(lines[0]).toBe("[Pattern Detector]");
      expect(lines[1]).toBe("UNKNOWN Caio (+5511988887777)");
      expect(lines[2]).toBe("PHONE 11999998888");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
