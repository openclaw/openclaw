import type { Command } from "commander";
import { bootstrapTeamsOwner } from "../../gateway/authorization/teams-bootstrap.js";

type TeamsBootstrapStdin = NodeJS.ReadableStream & { isTTY?: boolean };

/** Read exactly one non-interactive password line without normalizing its content. */
export async function readTeamsBootstrapPasswordFromStdin(
  stdin: TeamsBootstrapStdin,
): Promise<string> {
  if (stdin.isTTY) {
    throw new Error("--password-stdin requires non-TTY stdin");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  let password = Buffer.concat(chunks).toString("utf8");
  if (password.endsWith("\n")) {
    password = password.slice(0, -1);
    if (password.endsWith("\r")) {
      password = password.slice(0, -1);
    }
  }
  if (password.includes("\n")) {
    throw new Error("--password-stdin requires exactly one line");
  }
  return password;
}

/** Register local Teams owner bootstrap without exposing credentials in command arguments or output. */
export function registerTeamsCommand(program: Command): void {
  const teams = program.command("teams").description("Manage local Teams authorization");
  teams
    .command("bootstrap")
    .description("Create the first local Teams owner and default workspace authorization tree")
    .requiredOption("--login-label <label>", "Local owner login label")
    .requiredOption("--password-stdin", "Read one password line from non-TTY standard input")
    .option("--domain-id <id>", "Isolation domain id")
    .action(async (opts) => {
      const password = await readTeamsBootstrapPasswordFromStdin(process.stdin);
      await bootstrapTeamsOwner({
        loginLabel: opts.loginLabel as string,
        password,
        domainId: opts.domainId as string | undefined,
      });
    });
}
