import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseClawHubPluginSpec,
  resolveClawHubAuthToken,
  searchClawHubSkills,
  resolveLatestVersionFromPackage,
  satisfiesGatewayMinimum,
  satisfiesPluginApiRange,
} from "./clawhub.js";

describe("clawhub helpers", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_CLAWHUB_TOKEN;
    delete process.env.CLAWHUB_TOKEN;
    delete process.env.CLAWHUB_AUTH_TOKEN;
    delete process.env.OPENCLAW_CLAWHUB_CONFIG_PATH;
    delete process.env.CLAWHUB_CONFIG_PATH;
    delete process.env.XDG_CONFIG_HOME;
  });

  it("parses explicit ClawHub package specs", () => {
    expect(parseClawHubPluginSpec("clawhub:demo")).toEqual({
      name: "demo",
    });
    expect(parseClawHubPluginSpec("clawhub:demo@1.2.3")).toEqual({
      name: "demo",
      version: "1.2.3",
    });
    expect(parseClawHubPluginSpec("@scope/pkg")).toBeNull();
  });

  it("resolves latest versions from latestVersion before tags", () => {
    expect(
      resolveLatestVersionFromPackage({
        package: {
          name: "demo",
          displayName: "Demo",
          family: "code-plugin",
          channel: "official",
          isOfficial: true,
          createdAt: 0,
          updatedAt: 0,
          latestVersion: "1.2.3",
          tags: { latest: "1.2.2" },
        },
      }),
    ).toBe("1.2.3");
    expect(
      resolveLatestVersionFromPackage({
        package: {
          name: "demo",
          displayName: "Demo",
          family: "code-plugin",
          channel: "official",
          isOfficial: true,
          createdAt: 0,
          updatedAt: 0,
          tags: { latest: "1.2.2" },
        },
      }),
    ).toBe("1.2.2");
  });

  it("checks plugin api ranges without semver dependency", () => {
    expect(satisfiesPluginApiRange("1.2.3", "^1.2.0")).toBe(true);
    expect(satisfiesPluginApiRange("1.9.0", ">=1.2.0 <2.0.0")).toBe(true);
    expect(satisfiesPluginApiRange("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfiesPluginApiRange("1.1.9", ">=1.2.0")).toBe(false);
    expect(satisfiesPluginApiRange("invalid", "^1.2.0")).toBe(false);
  });

  it("checks min gateway versions with loose host labels", () => {
    expect(satisfiesGatewayMinimum("2026.3.22", "2026.3.0")).toBe(true);
    expect(satisfiesGatewayMinimum("OpenClaw 2026.3.22", "2026.3.0")).toBe(true);
    expect(satisfiesGatewayMinimum("2026.2.9", "2026.3.0")).toBe(false);
    expect(satisfiesGatewayMinimum("unknown", "2026.3.0")).toBe(false);
  });

  it("resolves ClawHub auth token from config.json", async () => {
    const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-config-"));
    process.env.XDG_CONFIG_HOME = configRoot;
    await fs.mkdir(path.join(configRoot, "clawhub"), { recursive: true });
    await fs.writeFile(
      path.join(configRoot, "clawhub", "config.json"),
      JSON.stringify({ auth: { token: "cfg-token-123" } }),
      "utf8",
    );

    await expect(resolveClawHubAuthToken()).resolves.toBe("cfg-token-123");
  });

  it("injects resolved auth token into ClawHub requests", async () => {
    process.env.OPENCLAW_CLAWHUB_TOKEN = "env-token-123";
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).toContain("/api/v1/search");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer env-token-123");
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(searchClawHubSkills({ query: "calendar", fetchImpl })).resolves.toEqual([]);
  });
});
