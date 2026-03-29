import { afterEach, describe, expect, it } from "vitest";
import { __paperclipAuthEnvTestUtils } from "../src/agents/pi-embedded-runner/run.js";

describe("applyPaperclipRuntimeAuthEnv", () => {
  const envKeys = [
    "PAPERCLIP_API_URL",
    "PAPERCLIP_RUN_ID",
    "PAPERCLIP_AGENT_ID",
    "PAPERCLIP_COMPANY_ID",
    "PAPERCLIP_API_KEY",
    "PAPERCLIP_AUTH_HEADER",
  ] as const;

  afterEach(() => {
    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  it("overwrites stale PAPERCLIP_AUTH_HEADER for a new run and restores prior env", () => {
    const previousRunId = process.env.PAPERCLIP_RUN_ID;
    process.env.PAPERCLIP_AUTH_HEADER = "Bearer stale-content-token";
    process.env.PAPERCLIP_API_KEY = "stale-content-token";
    process.env.PAPERCLIP_AGENT_ID = "agent-content";

    const restore = __paperclipAuthEnvTestUtils.applyPaperclipRuntimeAuthEnv({
      paperclipRuntimeAuth: {
        apiUrl: "http://127.0.0.1:3100/",
        runId: "run-research",
        agentId: "agent-research",
        companyId: "company-1",
        authToken: "fresh-research-token",
        authScheme: "bearer",
      },
    });

    expect(process.env.PAPERCLIP_API_KEY).toBe("fresh-research-token");
    expect(process.env.PAPERCLIP_AUTH_HEADER).toBe("bearer fresh-research-token");
    expect(process.env.PAPERCLIP_AGENT_ID).toBe("agent-research");
    expect(process.env.PAPERCLIP_RUN_ID).toBe("run-research");

    restore();

    expect(process.env.PAPERCLIP_API_KEY).toBe("stale-content-token");
    expect(process.env.PAPERCLIP_AUTH_HEADER).toBe("Bearer stale-content-token");
    expect(process.env.PAPERCLIP_AGENT_ID).toBe("agent-content");
    expect(process.env.PAPERCLIP_RUN_ID).toBe(previousRunId);
  });
});
