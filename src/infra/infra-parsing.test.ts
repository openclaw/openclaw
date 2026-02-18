import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isDiagnosticFlagEnabled, resolveDiagnosticFlags } from "./diagnostic-flags.js";
import { isMainModule } from "./is-main.js";
import { buildNodeShellCommand } from "./node-shell.js";
import { parseSshTarget } from "./ssh-tunnel.js";

describe("infra parsing", () => {
  describe("diagnostic flags", () => {
    it("merges config + env flags", () => {
      const cfg = {
        diagnostics: { flags: ["telegram.http", "cache.*"] },
      } as OpenClawConfig;
      const env = {
        OPENCLAW_DIAGNOSTICS: "foo,bar",
      } as NodeJS.ProcessEnv;

      const flags = resolveDiagnosticFlags(cfg, env);
      expect(flags).toEqual(expect.arrayContaining(["telegram.http", "cache.*", "foo", "bar"]));
      expect(isDiagnosticFlagEnabled("telegram.http", cfg, env)).toBe(true);
      expect(isDiagnosticFlagEnabled("cache.hit", cfg, env)).toBe(true);
      expect(isDiagnosticFlagEnabled("foo", cfg, env)).toBe(true);
    });

    it("treats env true as wildcard", () => {
      const env = { OPENCLAW_DIAGNOSTICS: "1" } as NodeJS.ProcessEnv;
      expect(isDiagnosticFlagEnabled("anything.here", undefined, env)).toBe(true);
    });

    it("treats env false as disabled", () => {
      const env = { OPENCLAW_DIAGNOSTICS: "0" } as NodeJS.ProcessEnv;
      expect(isDiagnosticFlagEnabled("telegram.http", undefined, env)).toBe(false);
    });
  });

  describe("isMainModule", () => {
    it("returns true when argv[1] matches current file", () => {
      expect(
        isMainModule({
          currentFile: "/repo/dist/index.js",
          argv: ["node", "/repo/dist/index.js"],
          cwd: "/repo",
          env: {},
        }),
      ).toBe(true);
    });

    it("returns true under PM2 when pm_exec_path matches current file", () => {
      expect(
        isMainModule({
          currentFile: "/repo/dist/index.js",
          argv: ["node", "/pm2/lib/ProcessContainerFork.js"],
          cwd: "/repo",
          env: { pm_exec_path: "/repo/dist/index.js", pm_id: "0" },
        }),
      ).toBe(true);
    });

    it("returns false when running under PM2 but this module is imported", () => {
      expect(
        isMainModule({
          currentFile: "/repo/node_modules/openclaw/dist/index.js",
          argv: ["node", "/repo/app.js"],
          cwd: "/repo",
          env: { pm_exec_path: "/repo/app.js", pm_id: "0" },
        }),
      ).toBe(false);
    });
  });

  describe("buildNodeShellCommand", () => {
    it("uses cmd.exe for win32", () => {
      expect(buildNodeShellCommand("echo hi", "win32")).toEqual([
        "cmd.exe",
        "/d",
        "/s",
        "/c",
        "echo hi",
      ]);
    });

    it("uses cmd.exe for windows labels", () => {
      expect(buildNodeShellCommand("echo hi", "windows")).toEqual([
        "cmd.exe",
        "/d",
        "/s",
        "/c",
        "echo hi",
      ]);
      expect(buildNodeShellCommand("echo hi", "Windows 11")).toEqual([
        "cmd.exe",
        "/d",
        "/s",
        "/c",
        "echo hi",
      ]);
    });

    it("uses /bin/sh for darwin", () => {
      expect(buildNodeShellCommand("echo hi", "darwin")).toEqual(["/bin/sh", "-lc", "echo hi"]);
    });

    it("uses /bin/sh when platform missing", () => {
      expect(buildNodeShellCommand("echo hi")).toEqual(["/bin/sh", "-lc", "echo hi"]);
    });
  });

  describe("parseSshTarget", () => {
    it("parses user@host:port targets", () => {
      expect(parseSshTarget("me@example.com:2222")).toEqual({
        user: "me",
        host: "example.com",
        port: 2222,
      });
    });

    it("parses host-only targets with default port", () => {
      expect(parseSshTarget("example.com")).toEqual({
        user: undefined,
        host: "example.com",
        port: 22,
      });
    });

    it("rejects hostnames that start with '-'", () => {
      expect(parseSshTarget("-V")).toBeNull();
      expect(parseSshTarget("me@-badhost")).toBeNull();
      expect(parseSshTarget("-oProxyCommand=echo")).toBeNull();
    });
  });
});
