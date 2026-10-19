import "../src/test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  withCliHome,
  expectCliError,
  expectMissing,
  expectFailure,
  runIsolatedCli,
  cliCase,
} from "./cli-json-stdout-contract.test-support.js";

const interactiveRequired =
  "Agent creation needs an interactive TTY. Use `openclaw agents add <id> --non-interactive --workspace <dir>` for automation.";
const unknownAgent = 'Agent "ghost" not found. Create it with `openclaw agents add`.';
const bindingConflict = "telegram accountId=work (agent=ops)";

it.each([
  cliCase("agents add work", { message: interactiveRequired, human: true }),
  cliCase("agents add work --json", { message: interactiveRequired }),
  cliCase("agents add work --non-interactive --json", {
    message:
      "Non-interactive agent creation requires --workspace. Re-run openclaw agents add <id> --workspace <path> or omit flags to use the wizard.",
    tty: true,
  }),
  cliCase("agents bind --json", { message: "Provide at least one --bind <channel[:accountId]>." }),
  cliCase("agents unbind --all --bind telegram", {
    message: "Use either --all or --bind, not both.",
    human: true,
  }),
  cliCase("agents set-identity --agent ghost --name Ghost --json", { message: unknownAgent }),
  cliCase("agents set-identity --agent ghost --name Ghost --json", {
    message: unknownAgent,
    tty: true,
  }),
])("renders agent management $name through the canonical failure owner", async (testCase) => {
  await withCliHome(async (tempHome) => {
    const configPath = path.join(tempHome, "missing-openclaw.json");
    const workspace = path.join(tempHome, "workspace");
    const result = runIsolatedCli(tempHome, testCase.args, testCase);

    expectFailure(result, testCase.message, { ...testCase, once: true });
    await expectMissing(configPath, workspace);
  });
});

it("leaves existing config and IDENTITY.md untouched when set-identity rejects an agent", async () => {
  await withCliHome(async (tempHome) => {
    const configPath = path.join(tempHome, "openclaw.json");
    const workspace = path.join(tempHome, "workspace");
    const identityPath = path.join(workspace, "IDENTITY.md");
    const originalConfig = `${JSON.stringify({
      agents: { entries: { main: { workspace, identity: { name: "Original" } } } },
    })}\n`;
    const originalIdentity = "- Name: Original workspace identity\n";
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(configPath, originalConfig, "utf8");
    await fs.writeFile(identityPath, originalIdentity, "utf8");

    const result = runIsolatedCli(
      tempHome,
      ["agents", "set-identity", "--agent", "ghost", "--name", "Ghost", "--json"],
      { env: { OPENCLAW_CONFIG_PATH: configPath } },
    );

    expect(result.status, result.stderr).toBe(1);
    expectCliError(result.stdout, unknownAgent);
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(originalConfig);
    await expect(fs.readFile(identityPath, "utf8")).resolves.toBe(originalIdentity);
  });
});

const bindPayload = { agentId: "main", added: [], updated: [], skipped: [], conflicts: [] };
const unbindPayload = { agentId: "main", removed: [], missing: [], conflicts: [] };

it.each([
  cliCase("agents bindings --json", { payload: [] }),
  cliCase("agents bind --bind telegram:work --json", {
    payload: { ...bindPayload, added: ["telegram accountId=work"] },
    writesConfig: true,
  }),
  cliCase("agents unbind --all --json", { payload: unbindPayload }),
  cliCase("agents bind --agent main --bind telegram:work --json", {
    payload: { ...bindPayload, conflicts: [bindingConflict] },
    conflict: true,
  }),
  cliCase("agents unbind --agent main --bind telegram:work --json", {
    payload: { ...unbindPayload, conflicts: [bindingConflict] },
    conflict: true,
  }),
])("preserves agent binding $name as its existing domain payload", async (testCase) => {
  await withCliHome(async (tempHome) => {
    const configPath = path.join(tempHome, "openclaw.json");
    const existingConfig = `${JSON.stringify({
      agents: {
        ownership: "explicit",
        entries: {
          main: { workspace: path.join(tempHome, "main") },
          ops: { workspace: path.join(tempHome, "ops") },
        },
      },
      bindings: [
        { type: "route", agentId: "ops", match: { channel: "telegram", accountId: "work" } },
      ],
    })}\n`;
    if ("conflict" in testCase) {
      await fs.writeFile(configPath, existingConfig, "utf8");
    }

    const result = runIsolatedCli(tempHome, testCase.args, {
      env: { OPENCLAW_CONFIG_PATH: configPath },
    });

    expect(result.status, result.stderr).toBe("conflict" in testCase ? 1 : 0);
    expect(result.stdout, result.stderr).not.toBe("");
    expect(JSON.parse(result.stdout)).toEqual(testCase.payload);
    if ("writesConfig" in testCase) {
      await fs.access(configPath);
    } else if ("conflict" in testCase) {
      await expect(fs.readFile(configPath, "utf8")).resolves.toBe(existingConfig);
    } else {
      await expectMissing(configPath);
    }
  });
});
