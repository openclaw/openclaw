import { describe, expect, it } from "vitest";
import { resolveSandboxBrowserConfig } from "../agents/sandbox/config.js";
import { validateConfigObject } from "./config.js";

describe("sandbox docker config", () => {
  it("accepts binds array in sandbox.docker config", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              binds: ["/var/run/docker.sock:/var/run/docker.sock", "/home/user/source:/source:rw"],
            },
          },
        },
        list: [
          {
            id: "main",
            sandbox: {
              docker: {
                image: "custom-sandbox:latest",
                binds: ["/home/user/projects:/projects:ro"],
              },
            },
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.agents?.defaults?.sandbox?.docker?.binds).toEqual([
        "/var/run/docker.sock:/var/run/docker.sock",
        "/home/user/source:/source:rw",
      ]);
      expect(res.config.agents?.list?.[0]?.sandbox?.docker?.binds).toEqual([
        "/home/user/projects:/projects:ro",
      ]);
    }
  });

  it("rejects non-string values in binds array", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              binds: [123, "/valid/path:/path"],
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });
});

describe("sandbox browser binds config", () => {
  it("accepts binds array in sandbox.browser config", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            browser: {
              binds: ["/home/user/.chrome-profile:/data/chrome:rw"],
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.agents?.defaults?.sandbox?.browser?.binds).toEqual([
        "/home/user/.chrome-profile:/data/chrome:rw",
      ]);
    }
  });

  it("rejects non-string values in browser binds array", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            browser: {
              binds: [123],
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("merges global and agent browser binds", () => {
    const resolved = resolveSandboxBrowserConfig({
      scope: "agent",
      globalBrowser: { binds: ["/global:/global:ro"] },
      agentBrowser: { binds: ["/agent:/agent:rw"] },
    });
    expect(resolved.binds).toEqual(["/global:/global:ro", "/agent:/agent:rw"]);
  });

  it("treats empty binds as configured (override to none)", () => {
    const resolved = resolveSandboxBrowserConfig({
      scope: "agent",
      globalBrowser: { binds: [] },
      agentBrowser: {},
    });
    expect(resolved.binds).toEqual([]);
  });

  it("ignores agent browser binds under shared scope", () => {
    const resolved = resolveSandboxBrowserConfig({
      scope: "shared",
      globalBrowser: { binds: ["/global:/global:ro"] },
      agentBrowser: { binds: ["/agent:/agent:rw"] },
    });
    expect(resolved.binds).toEqual(["/global:/global:ro"]);

    const resolvedNoGlobal = resolveSandboxBrowserConfig({
      scope: "shared",
      globalBrowser: {},
      agentBrowser: { binds: ["/agent:/agent:rw"] },
    });
    expect(resolvedNoGlobal.binds).toBeUndefined();
  });

  it("returns undefined binds when none configured", () => {
    const resolved = resolveSandboxBrowserConfig({
      scope: "agent",
      globalBrowser: {},
      agentBrowser: {},
    });
    expect(resolved.binds).toBeUndefined();
  });
});
