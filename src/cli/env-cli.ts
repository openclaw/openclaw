import fs from "node:fs";
import path from "node:path";
/**
 * `openclaw env` — manage persistent gateway environment variables.
 *
 * Variables are stored in ~/.openclaw/.env (dotenv format) and are
 * automatically loaded by the gateway on startup, so you never need to
 * edit the LaunchAgent/systemd plist directly.
 *
 * Common use-cases:
 *   - Custom Anthropic API endpoint (corporate proxy / self-hosted)
 *   - ANTHROPIC_AUTH_TOKEN for non-OAuth deployments
 *   - HTTP_PROXY / HTTPS_PROXY for outbound traffic
 */
import type { Command } from "commander";
import { resolveConfigDir } from "../utils.js";

const ENV_FILE_NAME = ".env";

/** Parse a single "KEY=VALUE" assignment string. Value may contain `=`. */
export function parseAssignment(s: string): { key: string; value: string } | null {
  const eqIdx = s.indexOf("=");
  if (eqIdx === -1) {
    return null;
  }
  const key = s.slice(0, eqIdx).trim();
  if (!key) {
    return null;
  }
  const value = s.slice(eqIdx + 1).trim();
  return { key, value };
}

function getEnvFilePath(): string {
  return path.join(resolveConfigDir(process.env), ENV_FILE_NAME);
}

/**
 * Parse a simple dotenv file into a key→value map.
 * Supports:
 *   KEY=VALUE
 *   KEY="VALUE WITH SPACES"
 *   KEY='VALUE WITH SPACES'
 *   # comment lines
 *   blank lines
 */
function parseDotEnv(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) {
      continue;
    }
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    // Strip surrounding quotes and unescape.
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else if (val.startsWith("'") && val.endsWith("'")) {
      val = val.slice(1, -1);
    }
    if (key) {
      map.set(key, val);
    }
  }
  return map;
}

/**
 * Serialise a key→value map to dotenv format.
 * Note: comment lines and blank lines from the original file are not preserved;
 * only the key=value pairs in the map are written.
 */
function serialiseDotEnv(map: Map<string, string>): string {
  const lines: string[] = [];
  for (const [key, val] of map) {
    const hasDouble = val.includes('"');
    const hasSingle = val.includes("'");
    const needsQuotes = /[\s\\#]/.test(val) || hasDouble || hasSingle;
    let serialised: string;
    if (!needsQuotes) {
      serialised = val;
    } else if (hasDouble && !hasSingle) {
      // Use single quotes to avoid escaping double quotes.
      serialised = `'${val}'`;
    } else {
      // Use double quotes; escape internal double quotes and backslashes.
      serialised = `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    lines.push(`${key}=${serialised}`);
  }
  // Always end with a trailing newline.
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

function readEnvFile(): Map<string, string> {
  const p = getEnvFilePath();
  if (!fs.existsSync(p)) {
    return new Map();
  }
  try {
    return parseDotEnv(fs.readFileSync(p, "utf8"));
  } catch {
    return new Map();
  }
}

function writeEnvFile(map: Map<string, string>): void {
  const p = getEnvFilePath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // `mode` in writeFileSync is only applied on file creation; existing files
  // keep their current permissions. Use chmodSync afterwards to enforce 0o600
  // even when the file already exists (e.g. created manually with 0o644).
  fs.writeFileSync(p, serialiseDotEnv(map), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}

/**
 * Partially redact a value if its key looks like a secret.
 * Values ≤ 4 chars are fully masked to avoid leaking short tokens.
 */
function redactValue(key: string, val: string): string {
  const isSensitive = /token|key|secret|password|auth/i.test(key);
  if (!isSensitive) {
    return val;
  }
  return val.length <= 4
    ? "*".repeat(val.length)
    : `${val.slice(0, 4)}${"*".repeat(val.length - 4)}`;
}

/** @internal Exported only for unit tests. */
export const __test__ = {
  parseDotEnv,
  serialiseDotEnv,
  readEnvFile,
  writeEnvFile,
  parseAssignment,
  redactValue,
};

export function registerEnvCli(program: Command): void {
  const env = program
    .command("env")
    .description(
      "Manage persistent gateway environment variables (~/.openclaw/.env).\n" +
        "Variables are loaded automatically when the gateway starts — no plist editing required.\n\n" +
        "Common variables:\n" +
        "  ANTHROPIC_BASE_URL       Custom API endpoint (proxy / self-hosted)\n" +
        "  ANTHROPIC_AUTH_TOKEN     Auth token for non-OAuth deployments\n" +
        "  HTTP_PROXY / HTTPS_PROXY Outbound proxy for all gateway traffic",
    );

  // openclaw env list
  env
    .command("list")
    .alias("ls")
    .description("List all variables in ~/.openclaw/.env")
    .option("--json", "Output JSON", false)
    .action((opts: { json: boolean }) => {
      const map = readEnvFile();
      if (opts.json) {
        // Apply the same redaction as the human-readable path so that piped
        // output / CI logs don't inadvertently expose secrets.
        const redacted: Record<string, string> = {};
        for (const [key, val] of map) {
          redacted[key] = redactValue(key, val);
        }
        console.log(JSON.stringify(redacted, null, 2));
        return;
      }
      if (map.size === 0) {
        console.log("No gateway env vars set. Use `openclaw env set KEY=VALUE` to add one.");
        return;
      }
      console.log(`Gateway env vars (${getEnvFilePath()}):\n`);
      for (const [key, val] of map) {
        console.log(`  ${key}=${redactValue(key, val)}`);
      }
    });

  // openclaw env set KEY=VALUE [KEY=VALUE ...]
  env
    .command("set <assignments...>")
    .description(
      "Set one or more gateway env vars.\n\n" +
        "  openclaw env set ANTHROPIC_BASE_URL=https://my-proxy.example.com\n" +
        "  openclaw env set ANTHROPIC_AUTH_TOKEN=sk-... ANTHROPIC_MODEL=claude-4-sonnet\n\n" +
        "Restart the gateway after setting vars: openclaw gateway restart",
    )
    .action((assignments: string[]) => {
      const map = readEnvFile();
      const set: string[] = [];
      const errors: string[] = [];

      for (const assignment of assignments) {
        const parsed = parseAssignment(assignment);
        if (!parsed) {
          errors.push(`  Invalid format (expected KEY=VALUE): ${assignment}`);
          continue;
        }
        map.set(parsed.key, parsed.value);
        set.push(parsed.key);
      }

      if (errors.length) {
        for (const e of errors) {
          console.error(e);
        }
        if (!set.length) {
          process.exit(1);
        }
      }

      writeEnvFile(map);
      console.log(`Set: ${set.join(", ")}`);
      console.log(`Saved to: ${getEnvFilePath()}`);
      console.log(`\nRestart the gateway to apply: openclaw gateway restart`);
    });

  // openclaw env unset KEY [KEY ...]
  env
    .command("unset <keys...>")
    .description("Remove one or more gateway env vars.")
    .action((keys: string[]) => {
      const map = readEnvFile();
      const removed: string[] = [];
      const missing: string[] = [];

      for (const key of keys) {
        if (map.has(key)) {
          map.delete(key);
          removed.push(key);
        } else {
          missing.push(key);
        }
      }

      if (missing.length) {
        console.warn(`Not set (skipped): ${missing.join(", ")}`);
      }

      if (removed.length) {
        writeEnvFile(map);
        console.log(`Unset: ${removed.join(", ")}`);
        console.log(`\nRestart the gateway to apply: openclaw gateway restart`);
      }
    });

  // openclaw env path — just print the .env file path (useful for scripting)
  env
    .command("path")
    .description("Print the path to the .env file")
    .action(() => {
      console.log(getEnvFilePath());
    });
}
