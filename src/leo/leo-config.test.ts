import { describe, expect, it } from "vitest";
import { parseLeoConfig } from "./leo-config.js";

function fullConfig() {
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

function minimalConfig() {
  return {
    identity: {
      name: "Leo",
      role: "chief of staff",
      owner_name: "Ali",
    },
    orgs: {
      edubites: {
        google_workspace: {
          client_id: "cid",
          client_secret: "cs",
          refresh_token: "rt",
          email: "ali@edubites.com",
        },
      },
    },
  };
}

describe("parseLeoConfig", () => {
  it("parses a valid full config with 4 orgs and all services", () => {
    const result = parseLeoConfig(fullConfig());
    expect(result).toBeDefined();
    expect(result.identity.name).toBe("Leo");
    expect(result.identity.role).toBe("chief of staff");
    expect(result.identity.owner_name).toBe("Ali");
    expect(Object.keys(result.orgs)).toHaveLength(4);
  });

  it("parses a minimal config with identity and one org", () => {
    const result = parseLeoConfig(minimalConfig());
    expect(result).toBeDefined();
    expect(result.identity.name).toBe("Leo");
    expect(Object.keys(result.orgs)).toHaveLength(1);
    const edu = result.orgs.edubites;
    expect(edu.google_workspace.email).toBe("ali@edubites.com");
    expect(edu.slack).toBeUndefined();
    expect(edu.monday).toBeUndefined();
    expect(edu.asana).toBeUndefined();
    expect(edu.github).toBeUndefined();
  });

  it("rejects config without identity block", () => {
    const cfg = { orgs: minimalConfig().orgs };
    expect(() => parseLeoConfig(cfg)).toThrow();
  });

  it("rejects org entry without google_workspace", () => {
    const cfg = {
      identity: minimalConfig().identity,
      orgs: {
        broken: {
          slack: { bot_token: "xoxb-x", workspace_id: "W-X" },
        },
      },
    };
    expect(() => parseLeoConfig(cfg)).toThrow();
  });

  it("strips extra unknown top-level keys", () => {
    const cfg = { ...minimalConfig(), foo: "bar" };
    const result = parseLeoConfig(cfg);
    expect((result as Record<string, unknown>).foo).toBeUndefined();
  });

  it("rejects empty orgs object", () => {
    const cfg = {
      identity: minimalConfig().identity,
      orgs: {},
    };
    expect(() => parseLeoConfig(cfg)).toThrow();
  });
});
