import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as contextModule from "../agents/context.js";
import * as configModule from "../config/config.js";
import * as sessionsModule from "../config/sessions.js";
import * as sessionUtilsModule from "../gateway/session-utils.js";
import { getStatusSummary } from "./status.summary.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-status-"));
const storePath = path.join(tempDir, "sessions.json");

fs.writeFileSync(
  storePath,
  JSON.stringify({
    "agent:main:test": {
      key: "agent:main:test",
      updatedAt: Date.now(),
      modelOverride: "google/gemini-1.5-pro",
      model: "google/gemini-1.5-pro",
      modelProvider: "google",
    },
  }) + "\n",
);

describe("getStatusSummary context limit display", () => {
  it("shows correct context value when runtime model differs", async () => {
    vi.spyOn(configModule, "loadConfig").mockReturnValue({
      agents: {
        defaults: {
          model: "google/gemini-flash",
        },
      },
    } as unknown);

    vi.spyOn(sessionUtilsModule, "listAgentsForGateway").mockReturnValue({
      defaultId: "main",
      agents: [{ id: "main", isDefault: true }],
    } as unknown);

    vi.spyOn(sessionsModule, "resolveStorePath").mockReturnValue(storePath);

    vi.spyOn(contextModule, "lookupContextTokens").mockImplementation((modelId) => {
      if (modelId === "google/gemini-1.5-pro") {
        return 2000000;
      }
      if (modelId === "google/gemini-flash") {
        return 1000000;
      }
      return undefined;
    });

    const summary = await getStatusSummary({
      includeSensitive: true,
    });

    const session = summary.sessions?.recent?.find((s) => s.key === "agent:main:test");
    expect(session).toBeDefined();

    // gemini-1.5-pro has 2M tokens context window, should not be the 1M from gemini-flash
    expect(session?.contextTokens).toBe(2000000);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
