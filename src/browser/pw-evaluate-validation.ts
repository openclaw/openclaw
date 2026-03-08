const MAX_EVALUATE_FUNCTION_LENGTH = 8192;

type BlockedPattern = {
  pattern: RegExp;
  name: string;
};

const RAW_BLOCKED_PATTERNS: readonly BlockedPattern[] = [
  { pattern: /\\u[0-9a-fA-F]{4}/, name: "unicode-escape" },
  { pattern: /\\x[0-9a-fA-F]{2}/, name: "hex-escape" },
  { pattern: /`/, name: "template-literal" },
  { pattern: /\0/, name: "null-byte" },
  {
    pattern: /\bnavigator\s*\[\s*(['"])sendbeacon\1\s*\]\s*\(/i,
    name: "navigator[sendBeacon]",
  },
];

const CODE_BLOCKED_PATTERNS: readonly BlockedPattern[] = [
  { pattern: /\bfetch\s*\(/i, name: "fetch" },
  { pattern: /\bxmlhttprequest\b/i, name: "XMLHttpRequest" },
  { pattern: /\bwebsocket\s*\(/i, name: "WebSocket" },
  { pattern: /\bsendbeacon\s*\(/i, name: "sendBeacon" },
  { pattern: /(^|[^\w$.])eval\s*\(/i, name: "direct-eval" },
  { pattern: /\bnew\s+function\s*\(/i, name: "new Function" },
  { pattern: /\bimport\s*\(/i, name: "dynamic-import" },
  { pattern: /\bimportscripts\s*\(/i, name: "importScripts" },
];

export class UnsafeEvaluateCodeError extends Error {
  readonly pattern: string;

  constructor(pattern: string) {
    const reason = describeBlockedPattern(pattern);
    super(`Unsafe browser evaluate code blocked: ${reason}`);
    this.name = "UnsafeEvaluateCodeError";
    this.pattern = pattern;
  }
}

function describeBlockedPattern(pattern: string): string {
  switch (pattern) {
    case "max-length-exceeded":
      return `function body exceeds ${MAX_EVALUATE_FUNCTION_LENGTH} characters`;
    case "leading-quote-or-close-paren":
      return 'function body must not start with `"`, `\'`, or `)`';
    case "null-byte":
      return "function body must not contain null bytes";
    case "template-literal":
      return "function body must not use template literals (`...`)";
    case "unicode-escape":
      return "function body must not contain unicode escapes (\\uXXXX)";
    case "hex-escape":
      return "function body must not contain hex escapes (\\xXX)";
    case "fetch":
      return "network exfiltration API `fetch(...)` is not allowed";
    case "XMLHttpRequest":
      return "network exfiltration API `XMLHttpRequest` is not allowed";
    case "WebSocket":
      return "network exfiltration API `WebSocket(...)` is not allowed";
    case "sendBeacon":
    case "navigator[sendBeacon]":
      return "network exfiltration API `sendBeacon(...)` is not allowed";
    case "direct-eval":
      return "dynamic code execution via `eval(...)` is not allowed";
    case "new Function":
      return "dynamic code execution via `new Function(...)` is not allowed";
    case "dynamic-import":
      return "dynamic module loading via `import(...)` is not allowed";
    case "importScripts":
      return "dynamic module loading via `importScripts(...)` is not allowed";
    default:
      return `blocked unsafe pattern (${pattern})`;
  }
}

function assertLeadingTokenAllowed(code: string): void {
  const first = code[0];
  if (first === '"' || first === "'" || first === ")") {
    throw new UnsafeEvaluateCodeError("leading-quote-or-close-paren");
  }
}

function stripStringsAndComments(code: string): string {
  let i = 0;
  let mode: "code" | "single" | "double" | "template" | "line-comment" | "block-comment" = "code";
  let templateExprDepth = 0;
  let out = "";

  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];

    if (mode === "line-comment") {
      out += ch === "\n" ? "\n" : " ";
      if (ch === "\n") {
        mode = "code";
      }
      i += 1;
      continue;
    }

    if (mode === "block-comment") {
      if (ch === "*" && next === "/") {
        out += "  ";
        mode = "code";
        i += 2;
      } else {
        out += ch === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }

    if (mode === "single") {
      if (ch === "\\") {
        out += "  ";
        i += 2;
      } else {
        out += ch === "'" ? "'" : ch === "\n" ? "\n" : " ";
        if (ch === "'") {
          mode = "code";
        }
        i += 1;
      }
      continue;
    }

    if (mode === "double") {
      if (ch === "\\") {
        out += "  ";
        i += 2;
      } else {
        out += ch === '"' ? '"' : ch === "\n" ? "\n" : " ";
        if (ch === '"') {
          mode = "code";
        }
        i += 1;
      }
      continue;
    }

    if (mode === "template") {
      if (ch === "\\") {
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "`") {
        out += "`";
        mode = "code";
        i += 1;
        continue;
      }
      if (ch === "$" && next === "{") {
        out += "  ";
        templateExprDepth = 1;
        mode = "code";
        i += 2;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      out += "  ";
      mode = "line-comment";
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      mode = "block-comment";
      i += 2;
      continue;
    }
    if (ch === "'") {
      out += "'";
      mode = "single";
      i += 1;
      continue;
    }
    if (ch === '"') {
      out += '"';
      mode = "double";
      i += 1;
      continue;
    }
    if (ch === "`") {
      out += "`";
      mode = "template";
      i += 1;
      continue;
    }

    if (templateExprDepth > 0) {
      if (ch === "{") {
        templateExprDepth += 1;
      } else if (ch === "}") {
        templateExprDepth -= 1;
        if (templateExprDepth === 0) {
          out += ch;
          mode = "template";
          i += 1;
          continue;
        }
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

export function assertSafeEvaluateCode(code: string): void {
  if (code.length > MAX_EVALUATE_FUNCTION_LENGTH) {
    throw new UnsafeEvaluateCodeError("max-length-exceeded");
  }

  assertLeadingTokenAllowed(code);

  for (const blocked of RAW_BLOCKED_PATTERNS) {
    if (blocked.pattern.test(code)) {
      throw new UnsafeEvaluateCodeError(blocked.name);
    }
  }

  const sanitizedCode = stripStringsAndComments(code);
  const normalized = sanitizedCode.toLowerCase();
  for (const blocked of CODE_BLOCKED_PATTERNS) {
    if (blocked.pattern.test(normalized)) {
      throw new UnsafeEvaluateCodeError(blocked.name);
    }
  }
}
