import { describe, expect, it } from "vitest";
import { resolveReaderClient, resolveReaderWorkspaces, VALID_WORKSPACES } from "./client.js";

describe("resolveReaderWorkspaces", () => {
  it("returns configured workspaces from config", () => {
    const config = {
      workspaces: {
        zenloop: { botToken: "xoxb-zen", name: "Zenloop" },
        edubites: { botToken: "xoxb-edu", name: "Edubites" },
      },
    };
    const result = resolveReaderWorkspaces(config);
    expect(result).toHaveLength(2);
    expect(result.map((w) => w.id)).toContain("zenloop");
    expect(result.map((w) => w.id)).toContain("edubites");
  });

  it("filters out disabled workspaces", () => {
    const config = {
      workspaces: {
        zenloop: { botToken: "xoxb-zen", enabled: true },
        edubites: { botToken: "xoxb-edu", enabled: false },
      },
    };
    const result = resolveReaderWorkspaces(config);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("zenloop");
  });

  it("returns empty array when no workspaces configured", () => {
    const result = resolveReaderWorkspaces({});
    expect(result).toEqual([]);
  });
});

describe("resolveReaderClient", () => {
  it("returns a WebClient for a valid workspace with token", () => {
    const config = {
      workspaces: {
        zenloop: { botToken: "xoxb-zen-token" },
      },
    };
    const client = resolveReaderClient("zenloop", config);
    expect(client).toBeDefined();
  });

  it("throws for unknown workspace", () => {
    const config = {
      workspaces: {
        zenloop: { botToken: "xoxb-zen" },
      },
    };
    expect(() => resolveReaderClient("invalid", config)).toThrow(/Unknown workspace 'invalid'/);
  });

  it("throws when workspace has no bot token", () => {
    const config = {
      workspaces: {
        zenloop: {},
      },
    };
    expect(() => resolveReaderClient("zenloop", config)).toThrow(
      /No bot token configured for workspace 'zenloop'/,
    );
  });
});

describe("VALID_WORKSPACES", () => {
  it("contains all 4 workspace identifiers", () => {
    expect(VALID_WORKSPACES).toContain("saasgroup");
    expect(VALID_WORKSPACES).toContain("protaige");
    expect(VALID_WORKSPACES).toContain("edubites");
    expect(VALID_WORKSPACES).toContain("zenloop");
  });
});
