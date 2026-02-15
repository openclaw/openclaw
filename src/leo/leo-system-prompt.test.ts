import { describe, expect, it } from "vitest";
import type { LeoIdentityConfig } from "./types.js";
import { buildLeoSystemPrompt } from "./leo-system-prompt.js";

function fullConfig(): LeoIdentityConfig {
  return {
    identity: {
      name: "Leo",
      role: "chief of staff",
      owner_name: "Ali",
    },
    orgs: {
      edubites: {
        google_workspace: {
          client_id: "cid-edu",
          client_secret: "cs-edu",
          refresh_token: "rt-edu",
          email: "ali@edubites.com",
        },
        slack: { bot_token: "xoxb-edu", workspace_id: "W-EDU" },
        monday: { api_token: "mon-token" },
      },
      zenloop: {
        google_workspace: {
          client_id: "cid-zen",
          client_secret: "cs-zen",
          refresh_token: "rt-zen",
          email: "ali@zenloop.com",
        },
        slack: { bot_token: "xoxb-zen", workspace_id: "W-ZEN" },
        asana: { pat: "asana-pat", workspace_gid: "12345" },
        github: { pat: "ghp-zen", org_name: "zenloop" },
      },
    },
  };
}

function singleOrgConfig(): LeoIdentityConfig {
  return {
    identity: {
      name: "Leo",
      role: "chief of staff",
      owner_name: "Ali",
    },
    orgs: {
      protaige: {
        google_workspace: {
          client_id: "cid-pro",
          client_secret: "cs-pro",
          refresh_token: "rt-pro",
          email: "ali@protaige.com",
        },
        slack: { bot_token: "xoxb-pro", workspace_id: "W-PRO" },
        github: { pat: "ghp-pro", org_name: "protaige" },
      },
    },
  };
}

describe("buildLeoSystemPrompt", () => {
  it("contains the Leo identity line", () => {
    const prompt = buildLeoSystemPrompt(fullConfig());
    expect(prompt).toContain("You are Leo, Ali's personal AI chief of staff");
  });

  it("lists all configured orgs", () => {
    const prompt = buildLeoSystemPrompt(fullConfig());
    expect(prompt).toContain("edubites");
    expect(prompt).toContain("zenloop");
  });

  it("includes only the configured org for single-org config", () => {
    const prompt = buildLeoSystemPrompt(singleOrgConfig());
    expect(prompt).toContain("protaige");
    expect(prompt).not.toContain("edubites");
    expect(prompt).not.toContain("zenloop");
  });

  it("includes communication style directives", () => {
    const prompt = buildLeoSystemPrompt(fullConfig());
    expect(prompt.toLowerCase()).toContain("concise");
    expect(prompt.toLowerCase()).toContain("actionable");
  });

  it("mentions approval-required tools", () => {
    const prompt = buildLeoSystemPrompt(fullConfig());
    expect(prompt).toContain("gmail.send");
    expect(prompt.toLowerCase()).toContain("approval");
  });
});
