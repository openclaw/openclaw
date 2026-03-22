import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadJitsiBridgeDownstreamConfig } from "./downstream-config.js";

const tempPaths: string[] = [];
const previousConfigPath = process.env.OPENCLAW_JITSI_CONFIG_PATH;

afterEach(async () => {
  if (previousConfigPath === undefined) {
    delete process.env.OPENCLAW_JITSI_CONFIG_PATH;
  } else {
    process.env.OPENCLAW_JITSI_CONFIG_PATH = previousConfigPath;
  }
  await Promise.all(tempPaths.splice(0).map(async (entry) => fs.rm(entry, { force: true })));
});

describe("jitsi downstream config", () => {
  it("loads custom identity and prompt values from JSON file", async () => {
    const filePath = path.join(os.tmpdir(), `openclaw-jitsi-config-${Date.now()}.json`);
    tempPaths.push(filePath);
    await fs.writeFile(
      filePath,
      JSON.stringify({
        identity: {
          displayName: "Custom Assistant",
          roomTopicFallback: "custom-topic",
        },
        prompt: {
          baseInstructions: ["Line A", "Line B"],
          briefingTemplate: "R {{roomId}} => {{briefing}}",
          noBriefingTemplate: "R {{roomId}} => none",
        },
      }),
      "utf8",
    );

    process.env.OPENCLAW_JITSI_CONFIG_PATH = filePath;
    const config = loadJitsiBridgeDownstreamConfig();

    expect(config.identity.displayName).toBe("Custom Assistant");
    expect(config.identity.roomTopicFallback).toBe("custom-topic");
    expect(config.prompt.baseInstructions).toEqual(["Line A", "Line B"]);
    expect(config.prompt.briefingTemplate).toBe("R {{roomId}} => {{briefing}}");
  });
});
