import { describe, expect, it } from "vitest";
import { OpenClawSchemaShape } from "./zod-schema.root-shape.js";

const lightpandaProfile = {
  engine: "lightpanda",
  cdpUrl: "ws://127.0.0.1:9222/",
  attachOnly: true,
};

describe("browser engine config", () => {
  it.each(["ws://127.0.0.1:9222/", "ws://lightpanda:9222/", "wss://browser.example/cdp"])(
    "accepts explicit Lightpanda endpoints on hosts and Docker networks: %s",
    (cdpUrl) => {
      const result = OpenClawSchemaShape.browser.safeParse({
        profiles: { lightweight: { ...lightpandaProfile, cdpUrl } },
      });
      expect(result.success).toBe(true);
    },
  );

  it.each([
    ["engine", "unknown"],
    ["cdpUrl", undefined],
    ["cdpUrl", "http://127.0.0.1:9222"],
    ["cdpUrl", "not-a-url"],
    ["attachOnly", undefined],
    ["attachOnly", false],
    ["driver", "existing-session"],
    ["driver", "extension"],
    ["cdpPort", 9222],
    ["userDataDir", "/tmp/chrome-profile"],
    ["mcpCommand", "chrome-devtools-mcp"],
    ["mcpArgs", []],
    ["executablePath", "/usr/bin/chromium"],
    ["headless", false],
  ])("rejects incompatible Lightpanda %s=%s", (key, value) => {
    const result = OpenClawSchemaShape.browser.safeParse({
      profiles: { lightweight: { ...lightpandaProfile, [key as string]: value } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
        `profiles.lightweight.${key}`,
      );
    }
  });

  it("preserves Chromium profile configs and leaves the engine default implicit", () => {
    const browser = {
      profiles: {
        managed: { cdpPort: 18800, headless: true },
        remote: {
          engine: "chromium",
          cdpUrl: "https://browser.example",
          attachOnly: true,
          resetDefaultDownloadBehaviorOnAttach: true,
        },
        legacy: {
          driver: "clawd",
          cdpUrl: "https://legacy-browser.example",
          attachOnly: true,
          resetDefaultDownloadBehaviorOnAttach: true,
        },
        user: { driver: "existing-session" },
        chrome: { driver: "extension" },
      },
    };
    expect(OpenClawSchemaShape.browser.parse(browser)).toEqual(browser);
  });

  it.each([
    {
      name: "existing-session",
      profile: { driver: "existing-session", cdpUrl: "http://127.0.0.1:9222" },
    },
    { name: "extension", profile: { driver: "extension" } },
    { name: "implicit user", profile: { cdpUrl: "http://127.0.0.1:9222" } },
    {
      name: "Lightpanda",
      profile: { engine: "lightpanda", cdpUrl: "ws://127.0.0.1:9222", attachOnly: true },
    },
  ])("rejects download recovery on the unsupported $name driver", ({ profile }) => {
    const result = OpenClawSchemaShape.browser.safeParse({
      profiles: { user: { ...profile, resetDefaultDownloadBehaviorOnAttach: true } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
        "profiles.user.resetDefaultDownloadBehaviorOnAttach",
      );
    }
  });

  it.each(["mcpCommand", "mcpArgs"] as const)(
    "rejects download recovery when Chrome MCP is configured through %s",
    (key) => {
      const result = OpenClawSchemaShape.browser.safeParse({
        profiles: {
          remote: {
            driver: "openclaw",
            cdpUrl: "https://browser.example",
            attachOnly: true,
            resetDefaultDownloadBehaviorOnAttach: true,
            ...(key === "mcpCommand" ? { mcpCommand: "chrome-devtools-mcp" } : { mcpArgs: [] }),
          },
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
          "profiles.remote.resetDefaultDownloadBehaviorOnAttach",
        );
      }
    },
  );

  it("rejects download recovery when the profile is managed instead of attach-only", () => {
    const result = OpenClawSchemaShape.browser.safeParse({
      attachOnly: false,
      profiles: {
        managed: {
          driver: "openclaw",
          cdpPort: 9222,
          attachOnly: false,
          resetDefaultDownloadBehaviorOnAttach: true,
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
        "profiles.managed.resetDefaultDownloadBehaviorOnAttach",
      );
    }
  });

  it.each(["chromium", "lightpanda"])("rejects a shared Lightpanda endpoint with %s", (engine) => {
    const result = OpenClawSchemaShape.browser.safeParse({
      profiles: {
        lightweight: lightpandaProfile,
        alias: { engine, cdpUrl: "ws://127.0.0.1:9222", attachOnly: true },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("dedicated CDP endpoint");
    }
  });
});
