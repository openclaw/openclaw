import { describe, expect, it } from "vitest";
import type { LeoIdentityConfig } from "./types.js";
import { registerLeoTools } from "./leo-tool-registry.js";

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
      saasgroup: {
        google_workspace: {
          client_id: "cid-sas",
          client_secret: "cs-sas",
          refresh_token: "rt-sas",
          email: "ali@saasgroup.com",
        },
        slack: { bot_token: "xoxb-sas", workspace_id: "W-SAS" },
      },
    },
  };
}

function noMondayConfig(): LeoIdentityConfig {
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

const ALL_NAMESPACES = [
  "people",
  "gmail",
  "calendar",
  "slack_read",
  "asana",
  "monday",
  "github",
  "briefing",
];

describe("registerLeoTools", () => {
  it("returns tool definitions for all 8 namespaces with full config", () => {
    const tools = registerLeoTools(fullConfig());
    const namespaces = new Set(tools.map((t) => t.name.split(".")[0]));
    for (const ns of ALL_NAMESPACES) {
      expect(namespaces.has(ns)).toBe(true);
    }
  });

  it("omits monday tools when no monday credentials exist", () => {
    const tools = registerLeoTools(noMondayConfig());
    const mondayTools = tools.filter((t) => t.name.startsWith("monday."));
    expect(mondayTools).toHaveLength(0);
  });

  it("marks gmail.send as requiring approval", () => {
    const tools = registerLeoTools(fullConfig());
    const gmailSend = tools.find((t) => t.name === "gmail.send");
    expect(gmailSend).toBeDefined();
    expect(gmailSend!.requireApproval).toBe(true);
  });

  it("marks calendar.create as requiring approval", () => {
    const tools = registerLeoTools(fullConfig());
    const calCreate = tools.find((t) => t.name === "calendar.create");
    expect(calCreate).toBeDefined();
    expect(calCreate!.requireApproval).toBe(true);
  });

  it("each tool has name, description, and parameters", () => {
    const tools = registerLeoTools(fullConfig());
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeDefined();
    }
  });
});
