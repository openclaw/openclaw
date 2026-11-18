// The schema's English labels are Title Case and its enum values are identifiers.
// Settings reads in sentence case, so both are presented here; the config keeps its values.

// Spellings a label or enum word keeps wherever it appears.
const CANONICAL_WORDS = new Map(
  [
    "ACP",
    "AI",
    "AppArmor",
    "CA",
    "CPUs",
    "FS",
    "MIME",
    "MIMEs",
    "noVNC",
    "PIDs",
    "VNC",
    "API",
    "AWS",
    "CDP",
    "ChatGPT",
    "CLI",
    "CPU",
    "DM",
    "DMs",
    "DNS",
    "GPT",
    "HTTP",
    "HTTPS",
    "ID",
    "IDs",
    "IP",
    "JSON",
    "LAN",
    "MCP",
    "MB",
    "OAuth",
    "OTLP",
    "PDF",
    "RO",
    "RW",
    "SDK",
    "SMS",
    "SQLite",
    "SSE",
    "SSH",
    "STT",
    "TLS",
    "TTL",
    "TTS",
    "UI",
    "URL",
    "URLs",
    "WebRTC",
    "WebSocket",
    "AppleScript",
    "Anthropic",
    "Azure",
    "Bedrock",
    "Bun",
    "Chrome",
    "Chromium",
    "Claude",
    "Codex",
    "DeepSeek",
    "Discord",
    "Docker",
    "Feishu",
    "GitHub",
    "Git",
    "Google",
    "Lark",
    "Lightpanda",
    "Linux",
    "Matrix",
    "Mattermost",
    "Microsoft",
    "Ollama",
    "OpenAI",
    "OpenClaw",
    "OpenRouter",
    "OpenSSH",
    "Postgres",
    "Qwen",
    "Signal",
    "Slack",
    "Tailscale",
    "Teams",
    "Telegram",
    "Together",
    "Twitter",
    "Vertex",
    "WhatsApp",
    "Yarn",
    "ZAI",
  ].map((word) => [word.toLowerCase(), word]),
);

function canonicalWord(word: string): string | undefined {
  return CANONICAL_WORDS.get(word.toLowerCase());
}

function sentenceCaseWord(word: string, first: boolean): string {
  return word
    .split("-")
    .map((part, index) => {
      const bare = part.replace(/^[("'[]+|[)"'\],:.]+$/g, "");
      const canonical = canonicalWord(bare);
      if (canonical) {
        return part.replace(bare, canonical);
      }
      // Anything else with inner capitals or digits is a name: iMessage, gpt-5.
      if (!/^[A-Z][a-z]+$/.test(bare)) {
        return part;
      }
      return first && index === 0 ? part : part.replace(bare, bare.toLowerCase());
    })
    .join("-");
}

/** Title Case schema labels become sentence case, keeping acronyms and product names. */
export function sentenceCaseConfigLabel(label: string): string {
  // Labels derived from camelCase keys split these names in two.
  return label
    .replace(/\bGit Hub\b/i, "GitHub")
    .replace(/\bNo Vnc\b/i, "noVNC")
    .split(" ")
    .map((word, index, words) =>
      sentenceCaseWord(word, index === 0 || words[index - 1]!.endsWith(":")),
    )
    .join(" ")
    .replace(/\bClaude code\b/, "Claude Code");
}

const IDENTIFIER_VALUE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

/** Enum identifiers read as words: "message_tool" is "Message tool". Paths and names stay raw. */
export function humanizeConfigEnumValue(value: string): string {
  if (!IDENTIFIER_VALUE.test(value)) {
    return value;
  }
  const words = value.split(/[-_]/).map((word) => canonicalWord(word) ?? word);
  const [first = "", ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}
