import { formatCliCommand } from "../../cli/command-format.js";
import { quoteCliArg, quotePowerShellArg } from "../../cli/quote-cli-arg.js";

/**
 * Renders the transcript-trim command for each shell an operator may paste into. Bare keys read the
 * same everywhere; once a key needs quoting, POSIX, PowerShell, and cmd.exe spell it differently.
 */
function formatTrimCommands(params: { agentId?: string; sessionKey?: string }): string {
  const render = (quote: (value: string) => string) => {
    const arg = (value: string) => (quoteCliArg(value) === value ? value : quote(value));
    const keyArg = params.sessionKey ? arg(params.sessionKey) : "<session-key>";
    const agentArg = params.agentId ? ` --agent ${arg(params.agentId)}` : "";
    return `\`${formatCliCommand(`openclaw sessions compact ${keyArg}${agentArg} --max-lines 200`)}\``;
  };
  const posix = render(quoteCliArg);
  const powershell = render(quotePowerShellArg);
  // cmd.exe keeps single quotes as key characters; inside double quotes it leaves
  // ! and $ (Matrix keys) literal while delayed expansion is off, its default.
  const commandPrompt = render((value) => `"${value}"`);
  if (posix === commandPrompt) {
    return posix;
  }
  if (posix === powershell) {
    return `${posix} (macOS, Linux, or PowerShell) or ${commandPrompt} (Windows Command Prompt)`;
  }
  return `${posix} (macOS or Linux), ${powershell} (PowerShell), or ${commandPrompt} (Windows Command Prompt)`;
}

/** Builds recovery instructions while preserving the existing session mapping. */
export function buildContextOverflowRecoveryText(
  params: { agentId?: string; sessionKey?: string } = {},
): string {
  // Retrying or /compact repeats the LLM compaction that just failed, so the
  // session-preserving fallback is mechanical trimming through the Gateway.
  return (
    "⚠️ Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Use /new to start a fresh session." +
    "\n\nTry a model with a larger context window." +
    "\n\nTo keep this session instead, an operator can trim its transcript. Trimming permanently deletes older history and keeps no backup, so run " +
    `\`${formatCliCommand("openclaw backup create")}\` first if that history matters, then ` +
    `${formatTrimCommands(params)}.`
  );
}
