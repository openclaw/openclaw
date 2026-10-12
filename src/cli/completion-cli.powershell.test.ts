import { afterAll, describe, expect } from "vitest";
import { getCompletionScript } from "./completion-cli.js";
import {
  createDocumentedCompletionProgram,
  itWithPowerShell,
  PowerShellCompletionRunner,
} from "./completion-cli.test-support.js";

const powerShellCompletion = new PowerShellCompletionRunner();

afterAll(async () => {
  await powerShellCompletion.close();
});

describe("PowerShell completion option terminators", () => {
  const program = createDocumentedCompletionProgram();
  program.command("cron").command("show").argument("<id>").option("--json");
  program.command("infer").alias("capability").command("embedding");
  const gateway = program.commands.find((command) => command.name() === "gateway");
  if (!gateway) {
    throw new Error("Gateway command is unavailable");
  }
  gateway.command("stability").option("--bundle [path]").option("--json");
  program
    .command("message")
    .command("send")
    .option("-m, --message <text>")
    .option("-t, --target <id>")
    .option("--json");
  const script = getCompletionScript("powershell", program);

  itWithPowerShell.each([
    ["openclaw cron show -- --j", []],
    ["openclaw -- g", ["gateway"]],
    ["openclaw cron -- sh", ["show"]],
    ["openclaw capability -- emb", ["embedding"]],
    ["openclaw gateway --token -- status --j", ["--json"]],
    ["openclaw gateway --token=-- status --j", ["--json"]],
    ["openclaw completion -ys -- --s", ["--shell"]],
    ["openclaw completion -ysbash -- --s", []],
    ["openclaw message send -mt -- --j", []],
    ["openclaw gateway stability --bundle -- --j", []],
    ["openclaw gateway stability --bundle latest -- --j", []],
    ["openclaw gateway stability --bundle --token -- --j", ["--json"]],
    ["openclaw cron show '--' --j", []],
    ['openclaw cron show "--" --j', []],
  ])("honors operands and terminators in %s", async (commandLine, expected) => {
    expect(await powerShellCompletion.completeScript(script, commandLine)).toEqual(expected);
  });

  itWithPowerShell("does not offer option values after a terminator", async () => {
    const completions = await powerShellCompletion.completeScript(
      script,
      "openclaw completion -- --shell f",
    );
    // PowerShell may still suggest files for the positional argument.
    expect(completions).not.toContain("fish");
  });

  itWithPowerShell("does not offer options after a terminator and trailing space", async () => {
    const completions = await powerShellCompletion.completeScript(script, "openclaw cron -- ");
    expect(completions).toContain("show");
    expect(completions.some((value) => value.startsWith("-"))).toBe(false);
  });

  itWithPowerShell("ignores a terminator after the cursor", async () => {
    const prefix = "openclaw cron show --j";
    expect(
      await powerShellCompletion.completeScript(script, `${prefix} --`, prefix.length),
    ).toEqual(["--json"]);
  });
});
