import type { Command } from "commander";
import {
  tokenCreate,
  tokenInspect,
  tokenList,
  tokenPrune,
  tokenRevoke,
  tokenRotateKey,
} from "../commands/token.js";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { formatHelpExamples } from "./help-format.js";

export function registerTokenCli(program: Command) {
  const token = program
    .command("token")
    .description("Create, manage, and inspect scoped gateway tokens")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            'openclaw token create --subject "cli-laptop" --scopes "read,write" --ttl 24h',
            "Create a 24h read/write token.",
          ],
          [
            'openclaw token create --subject "ci-readonly" --scopes "read" --ttl 1h --role node',
            "Create a 1h read-only node token.",
          ],
          ["openclaw token list", "Show all tokens with status."],
          ["openclaw token revoke <jti>", "Revoke a specific token."],
          ["openclaw token revoke --all", "Revoke all tokens."],
          ["openclaw token rotate-key", "Rotate the signing key."],
          ["openclaw token inspect <token>", "Decode and show token payload."],
        ])}\n`,
    );

  token
    .command("create")
    .description("Generate a new scoped gateway token")
    .requiredOption("--subject <name>", "Human label for the token (e.g. cli-laptop)")
    .requiredOption("--scopes <scopes>", "Comma-separated scopes (e.g. read,write,admin)")
    .option("--ttl <duration>", "Token lifetime (e.g. 1h, 24h, 30d)")
    .option("--role <role>", "Gateway role: operator or node", "operator")
    .option("--methods <methods>", "Comma-separated method allowlist (overrides scope-based)")
    .option("--json", "Output JSON", false)
    .action(
      async (opts: {
        subject: string;
        scopes: string;
        ttl?: string;
        role?: string;
        methods?: string;
        json?: boolean;
      }) => {
        const cfg = loadConfig();
        const stateDir = resolveStateDir();
        const scopedTokenConfig = cfg.gateway?.auth?.scopedTokens;

        const result = tokenCreate({
          subject: opts.subject,
          scopes: opts.scopes,
          ttl: opts.ttl,
          role: opts.role,
          methods: opts.methods,
          scopedTokenConfig,
          stateDir,
        });

        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }

        const lines: string[] = [];
        lines.push(theme.success("Token created successfully."));
        lines.push(`  Subject:  ${result.subject}`);
        lines.push(`  Token ID: ${result.jti}`);
        lines.push(`  Role:     ${result.role}`);
        lines.push(`  Scopes:   ${result.scopes.join(", ")}`);
        if (result.expiresAt) {
          const expiresDate = new Date(result.expiresAt * 1000).toISOString();
          lines.push(`  Expires:  ${expiresDate}`);
        } else {
          lines.push(`  Expires:  never`);
        }
        lines.push("");
        lines.push(`  Token: ${result.tokenString}`);
        lines.push("");
        lines.push(theme.warn("  Store this token securely. It will not be shown again."));
        defaultRuntime.log(lines.join("\n"));
      },
    );

  token
    .command("list")
    .description("List all tokens with their status")
    .option("--json", "Output JSON", false)
    .action(async (opts: { json?: boolean }) => {
      const stateDir = resolveStateDir();
      const entries = tokenList({ stateDir });

      if (opts.json) {
        defaultRuntime.log(JSON.stringify(entries, null, 2));
        return;
      }

      if (entries.length === 0) {
        defaultRuntime.log("No tokens found.");
        return;
      }

      const lines: string[] = [];
      lines.push(theme.heading(`Tokens (${entries.length}):`));
      lines.push("");
      for (const entry of entries) {
        const statusColor =
          entry.status === "active"
            ? theme.success
            : entry.status === "revoked"
              ? theme.error
              : theme.warn;
        lines.push(
          `  ${entry.jti.slice(0, 12)}…  ${entry.subject.padEnd(20)}  ${entry.role.padEnd(10)}  ${statusColor(entry.status)}`,
        );
        lines.push(
          `    scopes: ${entry.scopes.join(", ")}  issued: ${new Date(entry.issuedAt * 1000).toISOString()}`,
        );
      }
      defaultRuntime.log(lines.join("\n"));
    });

  token
    .command("revoke [jti]")
    .description("Revoke a token by ID, or all tokens with --all")
    .option("--all", "Revoke all tokens", false)
    .action(async (jti: string | undefined, opts: { all?: boolean }) => {
      const stateDir = resolveStateDir();
      const count = tokenRevoke({ jti, all: opts.all, stateDir });
      defaultRuntime.log(`Revoked ${count} token(s).`);
    });

  token
    .command("rotate-key")
    .description("Rotate the signing key (old tokens enter grace period)")
    .action(async () => {
      const cfg = loadConfig();
      const stateDir = resolveStateDir();
      tokenRotateKey({
        scopedTokenConfig: cfg.gateway?.auth?.scopedTokens,
        stateDir,
      });
      defaultRuntime.log("Signing key rotated. All existing tokens have been revoked.");
    });

  token
    .command("inspect <token>")
    .description("Decode and show a token payload (without verifying signature)")
    .option("--json", "Output JSON", false)
    .action(async (tokenString: string, opts: { json?: boolean }) => {
      const payload = tokenInspect(tokenString);
      if (!payload) {
        defaultRuntime.log("Failed to parse token. Ensure it starts with osc_ and is valid.");
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        defaultRuntime.log(JSON.stringify(payload, null, 2));
        return;
      }
      const lines: string[] = [];
      for (const [key, value] of Object.entries(payload)) {
        if (value !== undefined) {
          const display = Array.isArray(value) ? value.join(", ") : JSON.stringify(value);
          lines.push(`  ${key.padEnd(12)} ${display}`);
        }
      }
      defaultRuntime.log(lines.join("\n"));
    });

  token
    .command("prune")
    .description("Remove expired+revoked token metadata from the store")
    .action(async () => {
      const stateDir = resolveStateDir();
      const removed = tokenPrune({ stateDir });
      defaultRuntime.log(`Pruned ${removed} expired/revoked token(s).`);
    });
}
