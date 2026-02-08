import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import {
  loadAllowlist,
  addToAllowlist,
  removeFromAllowlist,
  loadProxyPort,
  setProxyPort,
  DEFAULT_PROXY_PORT,
} from "../../security/secrets-proxy-allowlist.js";

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

  allowlist
    .command("port [value]")
    .description("Get or set the secrets proxy port")
    .action((value?: string) => {
      if (value === undefined) {
        const port = loadProxyPort();
        defaultRuntime.log(`Secrets proxy port: ${port} (default: ${DEFAULT_PROXY_PORT})`);
        return;
      }
      const port = Number(value);
      if (!Number.isFinite(port) || port <= 0 || port > 65535 || !Number.isInteger(port)) {
        defaultRuntime.error("Invalid port. Must be an integer between 1 and 65535.");
        return;
      }
      try {
        setProxyPort(port);
        defaultRuntime.log(`Secrets proxy port set to ${port}.`);
      } catch (err) {
        defaultRuntime.error(`Failed to set proxy port: ${String(err)}`);
      }
    });

  return allowlist;
}

