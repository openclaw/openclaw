import "../src/test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  withCliHome,
  isolatedEnv,
  expectCleanOutput,
  expectCliError,
  expectMissing,
  ttySource,
} from "./cli-json-stdout-contract.test-support.js";
import { runBuiltCli } from "./cli-json-stdout.test-support.js";

describe("cli json stdout contract", () => {
  it.each([
    { name: "an ownerless explicit fleet", ownerSelected: false },
    { name: "an explicit system owner", ownerSelected: true },
  ])("preserves plugin diagnostic classifications for $name", async ({ ownerSelected }) => {
    await withCliHome(async (tempHome) => {
      const configPath = path.join(tempHome, "openclaw.json");
      const config = {
        agents: {
          ownership: "explicit",
          entries: { alpha: {}, beta: {} },
          ...(ownerSelected ? { defaults: { systemAgent: { agentId: "alpha" } } } : {}),
        },
        plugins: { enabled: false },
      };
      const configText = JSON.stringify(config);
      await fs.writeFile(configPath, configText);
      const env = {
        OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        NO_COLOR: "1",
      };
      const list = runBuiltCli(tempHome, ["plugins", "list", "--json"], env, {
        inheritEnvironment: false,
      });
      expect(list.error).toBeUndefined();
      expect(list.signal).toBeNull();
      expect(list.status, list.stderr).toBe(0);
      const inventory = JSON.parse(list.stdout);
      expect(inventory.workspaceScope).toBe(ownerSelected ? "selected" : "omitted");
      const workspaceDiagnostic = inventory.diagnostics.find(
        (entry: { code?: string }) => entry.code === "workspace-scope-omitted",
      );
      if (ownerSelected) {
        expect(workspaceDiagnostic).toBeUndefined();
      } else {
        expect(workspaceDiagnostic).toMatchObject({
          level: "warn",
          code: "workspace-scope-omitted",
          message: expect.stringContaining("Workspace plugin discovery was skipped"),
        });
      }

      const doctorJson = runBuiltCli(tempHome, ["plugins", "doctor", "--json"], env, {
        inheritEnvironment: false,
      });
      const doctorText = runBuiltCli(tempHome, ["plugins", "doctor"], env, {
        inheritEnvironment: false,
      });
      for (const result of [doctorJson, doctorText]) {
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status, result.stderr).toBe(ownerSelected ? 0 : 1);
      }
      expectCleanOutput(doctorJson.stdout);
      const diagnostics = JSON.parse(doctorJson.stdout);
      expect(diagnostics.ok).toBe(ownerSelected);
      expect(await fs.readFile(configPath, "utf8")).toBe(configText);
      if (ownerSelected) {
        expect(diagnostics.diagnostics).not.toContainEqual(
          expect.objectContaining({ code: "workspace-scope-omitted" }),
        );
        expect(doctorText.stdout).not.toContain("Workspace plugin discovery was skipped");
        expect(doctorText.stdout).toContain("configuration checks passed");
      } else {
        expect(doctorText.stdout).toContain(workspaceDiagnostic.message);
        expect(doctorText.stdout).not.toContain("configuration checks passed");
        expect(diagnostics.diagnostics).toContainEqual(workspaceDiagnostic);
      }
    });
  });

  it.each([
    {
      name: "the search query is missing",
      args: ["plugins", "search", "--json"],
      message: "Usage: openclaw plugins search <query>",
    },
    {
      name: "ClawHub transport fails",
      args: ["plugins", "search", "fixture", "--json"],
      message: "offline fixture",
      genericStderr: true,
    },
  ])("returns one canonical JSON document when plugins $name", async (testCase) => {
    await withCliHome(async (tempHome) => {
      const preload = `data:text/javascript,${encodeURIComponent(
        'globalThis.fetch = async () => { throw new Error("offline fixture"); };',
      )}`;
      const result = runBuiltCli(
        tempHome,
        testCase.args,
        {
          ...isolatedEnv(tempHome),
          CLAWHUB_CONFIG_PATH: path.join(tempHome, "missing-clawhub.json"),
          CLAWHUB_TOKEN: "",
          CLAWHUB_AUTH_TOKEN: "",
        },
        { execArgv: [`--import=${preload}`] },
      );

      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout, result.stderr).not.toBe("");
      expectCleanOutput(result.stdout);
      expectCliError(result.stdout, testCase.message);
      if ("genericStderr" in testCase) {
        expect(result.stderr).toContain("[openclaw] The CLI command failed.");
        expect(result.stderr).not.toContain(testCase.message);
      } else {
        expect(result.stderr).toContain(testCase.message);
      }
    });
  });

  it("keeps plugins search JSON failures clean through dual-TTY finalization", async () => {
    await withCliHome(async (tempHome) => {
      const preload = `data:text/javascript,${encodeURIComponent(ttySource.join("\n"))}`;
      const result = runBuiltCli(
        tempHome,
        ["plugins", "search", "--json"],
        {},
        {
          execArgv: [`--import=${preload}`],
        },
      );

      expect(result.status, result.stderr).toBe(1);
      expectCliError(result.stdout, "Usage: openclaw plugins search <query>");
      expectCleanOutput(result.stdout);
      expect(result.stderr).toContain("Usage: openclaw plugins search <query>");
      expect(result.stderr).toContain("\u001B[?25h");
    });
  });

  it.each([
    { name: "a missing local marketplace", source: "local" },
    {
      name: "a missing local marketplace through forced Commander",
      source: "local",
      commander: true,
    },
    { name: "a missing local marketplace with dual TTYs", source: "local", tty: true },
    { name: "an unavailable Git marketplace", source: "git" },
    { name: "an unavailable Git marketplace with dual TTYs", source: "git", tty: true },
    { name: "a missing local marketplace in human mode", source: "local", human: true },
    { name: "an unavailable Git marketplace in human mode", source: "git", human: true },
  ])("keeps $name failures on the canonical marketplace output boundary", async (testCase) => {
    await withCliHome(async (tempHome) => {
      const stateDir = path.join(tempHome, "isolated-state");
      const configPath = path.join(tempHome, "missing-openclaw.json");
      const source =
        testCase.source === "git"
          ? "ssh://marketplace.invalid/openclaw/unavailable.git"
          : path.join(tempHome, "missing-marketplace");
      const ttyPreload = Buffer.from(ttySource.join("\n")).toString("base64");

      await expectMissing(stateDir);

      const result = runBuiltCli(
        tempHome,
        ["plugins", "marketplace", "list", source, ...("human" in testCase ? [] : ["--json"])],
        {
          GIT_SSH_COMMAND: `${JSON.stringify(process.execPath)} -e "process.exit(1)"`,
          GIT_TERMINAL_PROMPT: "0",
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: stateDir,
          ...("commander" in testCase ? { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } : {}),
        },
        {
          inheritEnvironment: false,
          execArgv: "tty" in testCase ? [`--import=data:text/javascript;base64,${ttyPreload}`] : [],
        },
      );
      const expectedMessage =
        testCase.source === "git"
          ? `failed to clone marketplace source ${source}:`
          : `unsupported marketplace source: ${source}`;

      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(expectedMessage);

      if ("human" in testCase) {
        if (testCase.source === "git") {
          expect(result.stdout).toContain(`Cloning marketplace source ${source}...`);
        }
      } else {
        expectCleanOutput(result.stdout, result.stderr);
        expect(result.stdout).not.toContain("Cloning marketplace source");
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message:
              testCase.source === "git"
                ? expect.stringContaining(expectedMessage)
                : expectedMessage,
          },
        });
        if ("tty" in testCase) {
          expect(result.stderr).toContain("\u001B[?25h");
        }
      }

      if (testCase.source === "git") {
        expect(result.stderr).toContain("fatal: Could not read from remote repository.");
        const clonePath = /Cloning into '([^']+)'\.\.\./u.exec(result.stderr)?.[1];
        expect(clonePath).toBeDefined();
        await expectMissing(path.dirname(clonePath as string));
      }

      await expectMissing(stateDir, configPath, path.join(tempHome, ".claude"));
    });
  });
});
