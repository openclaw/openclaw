import type { Command } from "commander";
import { 
  loadAllowlist, 
  addToAllowlist, 
  removeFromAllowlist 
} from "../../security/secrets-proxy-allowlist.js";
import { defaultRuntime } from "../../runtime.js";

export function addGatewayAllowlistCommands(cmd: Command): Command {
  const allowlist = cmd
    .command("allowlist")
    .description("Manage the secrets proxy domain allowlist");

  allowlist
    .command("list")
    .description("List all allowed domains")
    .action(() => {
      const domains = loadAllowlist();
      defaultRuntime.log("Allowed domains:");
      for (const domain of domains) {
        defaultRuntime.log(`- ${domain}`);
      }
    });

  allowlist
    .command("add <domain>")
    .description("Add a domain to the allowlist")
    .action((domain: string) => {
      try {
        addToAllowlist(domain);
        defaultRuntime.log(`Added ${domain} to allowlist.`);
      } catch (err) {
        defaultRuntime.error(`Failed to add ${domain} to allowlist: ${String(err)}`);
      }
    });

  allowlist
    .command("remove <domain>")
    .description("Remove a domain from the allowlist")
    .action((domain: string) => {
      try {
        removeFromAllowlist(domain);
        defaultRuntime.log(`Removed ${domain} from allowlist.`);
      } catch (err) {
        defaultRuntime.error(`Failed to remove ${domain} from allowlist: ${String(err)}`);
      }
    });

  return allowlist;
}
