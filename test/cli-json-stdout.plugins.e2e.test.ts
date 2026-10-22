import "../src/test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  withCliHome,
  isolatedEnv,
  expectCleanOutput,
  expectCliError,
  expectMissing,
  ttySource,
  preloadArgs,
  cliCase,
  runIsolatedCli,
} from "./cli-json-stdout-contract.test-support.js";
import { runBuiltCli } from "./cli-json-stdout.test-support.js";

it.each([
  { name: "an ownerless explicit fleet", ownerSelected: false },
  { name: "an explicit system owner", ownerSelected: true },
])("preserves plugin diagnostic classifications for $name", async ({ ownerSelected }) => {
  await withCliHome(async (tempHome) => {
    const configPath = path.join(tempHome, "openclaw.json");
    const configText = JSON.stringify({
      agents: {
        ownership: "explicit",
        entries: { alpha: {}, beta: {} },
        ...(ownerSelected ? { defaults: { systemAgent: { agentId: "alpha" } } } : {}),
      },
      plugins: { enabled: false },
    });
    await fs.writeFile(configPath, configText);
    const env = {
      OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      NO_COLOR: "1",
    };
    const run = (...args: string[]) =>
      runBuiltCli(tempHome, ["plugins", ...args], env, {
        inheritEnvironment: false,
      });
    const list = run("list", "--json");
    expect(list.error, list.stderr).toBeUndefined();
    expect(list, list.stderr).toMatchObject({ signal: null, status: 0 });
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

    const doctorJson = run("doctor", "--json");
    const doctorText = run("doctor");
    for (const result of [doctorJson, doctorText]) {
      expect(result.error, result.stderr).toBeUndefined();
      expect(result, result.stderr).toMatchObject({
        signal: null,
        status: ownerSelected ? 0 : 1,
      });
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
  cliCase("plugins search --json", { message: "Usage: openclaw plugins search <query>" }),
  cliCase("plugins search fixture --json", { message: "offline fixture", genericStderr: true }),
  cliCase("plugins search --json", {
    message: "Usage: openclaw plugins search <query>",
    tty: true,
  }),
])("returns one canonical JSON document when plugins $name", async (testCase) => {
  await withCliHome(async (tempHome) => {
    const source =
      "tty" in testCase
        ? ttySource
        : ['globalThis.fetch = async () => { throw new Error("offline fixture"); };'];
    const result = runBuiltCli(
      tempHome,
      testCase.args,
      "tty" in testCase
        ? {}
        : {
            ...isolatedEnv(tempHome),
            CLAWHUB_CONFIG_PATH: path.join(tempHome, "missing-clawhub.json"),
            CLAWHUB_TOKEN: "",
            CLAWHUB_AUTH_TOKEN: "",
          },
      { execArgv: preloadArgs(source) },
    );

    expect(result.status, result.stderr).toBe(1);
    expectCleanOutput(result.stdout);
    expectCliError(result.stdout, testCase.message);
    if ("genericStderr" in testCase) {
      expect(result.stderr).toContain("[openclaw] The CLI command failed.");
      expect(result.stderr).not.toContain(testCase.message);
    } else {
      expect(result.stderr).toContain(testCase.message);
    }
    if ("tty" in testCase) {
      expect(result.stderr).toContain("\u001B[?25h");
    }
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
    const result = runIsolatedCli(
      tempHome,
      ["plugins", "marketplace", "list", source, ...("human" in testCase ? [] : ["--json"])],
      {
        commander: "commander" in testCase,
        source: "tty" in testCase ? ttySource : undefined,
        inheritEnvironment: false,
        env: {
          GIT_SSH_COMMAND: `${JSON.stringify(process.execPath)} -e "process.exit(1)"`,
          GIT_TERMINAL_PROMPT: "0",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
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
      expectCliError(
        result.stdout,
        testCase.source === "git" ? expect.stringContaining(expectedMessage) : expectedMessage,
      );
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
