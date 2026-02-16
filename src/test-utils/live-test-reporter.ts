import type { SerializedError } from "@vitest/utils";
import type { TestCase, TestModule } from "vitest/node";
import type { Reporter, TestRunEndReason } from "vitest/reporters";

// ANSI color codes
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GRAY = "\x1b[90m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// Mapping of environment variable keys to the live test files they enable
const LIVE_TEST_KEY_MAP: Record<string, { keys: string[]; files: string[] }> = {
  ANTHROPIC_API_KEY: {
    keys: ["ANTHROPIC_API_KEY", "OPENCLAW_LIVE_SETUP_TOKEN_VALUE"],
    files: ["src/agents/anthropic.setup-token.live.test.ts"],
  },
  MINIMAX_API_KEY: {
    keys: ["MINIMAX_API_KEY"],
    files: ["src/agents/minimax.live.test.ts"],
  },
  GEMINI_API_KEY: {
    keys: ["GEMINI_API_KEY"],
    files: ["src/agents/google-gemini-switch.live.test.ts"],
  },
  ZAI_API_KEY: {
    keys: ["ZAI_API_KEY", "Z_AI_API_KEY"],
    files: ["src/agents/zai.live.test.ts"],
  },
  OPENAI_API_KEY: {
    keys: ["OPENAI_API_KEY"],
    files: ["src/agents/pi-embedded-runner-extraparams.live.test.ts"],
  },
  OPENCLAW_LIVE_MODELS: {
    keys: ["OPENCLAW_LIVE_MODELS"],
    files: ["src/agents/models.profiles.live.test.ts"],
  },
  OPENCLAW_LIVE_BROWSER_CDP_URL: {
    keys: ["OPENCLAW_LIVE_BROWSER_CDP_URL"],
    files: ["src/browser/pw-session.browserless.live.test.ts"],
  },
  OPENCLAW_LIVE_CLI_BACKEND: {
    keys: ["OPENCLAW_LIVE_CLI_BACKEND"],
    files: ["src/gateway/gateway-cli-backend.live.test.ts"],
  },
  OPENCLAW_LIVE_GATEWAY: {
    keys: ["OPENCLAW_LIVE_GATEWAY"],
    files: ["src/gateway/gateway-models.profiles.live.test.ts"],
  },
  DEEPGRAM_API_KEY: {
    keys: ["DEEPGRAM_API_KEY"],
    files: ["src/media-understanding/providers/deepgram/audio.live.test.ts"],
  },
  OPENCLAW_LIVE_TELEGRAM_CHAT_ID: {
    keys: ["TELEGRAM_BOT_TOKEN", "OPENCLAW_LIVE_TELEGRAM_CHAT_ID"],
    files: ["src/telegram/telegram-e2e.live.test.ts"],
  },
};

/** Classify an error message into a short type label */
function classifyError(message: string): string {
  if (/\b401\b/.test(message) || /unauthorized/i.test(message)) {
    return "auth";
  }
  if (/\b403\b/.test(message) || /forbidden/i.test(message)) {
    return "forbidden";
  }
  if (/\b429\b/.test(message) || /rate.?limit/i.test(message)) {
    return "rate-limit";
  }
  if (/\b502\b/.test(message) || /\b503\b/.test(message) || /unavailable/i.test(message)) {
    return "unavailable";
  }
  if (/timeout/i.test(message) || /timed?\s*out/i.test(message)) {
    return "timeout";
  }
  if (/ECONNREFUSED/i.test(message) || /ENOTFOUND/i.test(message)) {
    return "network";
  }
  return "error";
}

/** Strip stack trace from an error message — keep only the first meaningful line */
function stripStack(message: string): string {
  const atIdx = message.indexOf("\n    at ");
  const cleaned = atIdx >= 0 ? message.slice(0, atIdx) : message;
  // Collapse multi-line to single line for display
  return cleaned.split("\n").filter(Boolean).join(" ").trim();
}

/** Format duration in a human-readable way */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

interface Counts {
  pass: number;
  fail: number;
  skip: number;
  unavailable: number;
}

export class LiveTestReporter implements Reporter {
  private startTime = 0;
  private counts: Counts = { pass: 0, fail: 0, skip: 0, unavailable: 0 };

  onInit(): void {
    this.startTime = Date.now();
    this.counts = { pass: 0, fail: 0, skip: 0, unavailable: 0 };
  }

  onTestModuleStart(testModule: TestModule): void {
    const relativePath = testModule.moduleId.includes("/")
      ? testModule.moduleId.slice(testModule.moduleId.lastIndexOf("/") + 1)
      : testModule.moduleId;
    console.log(`\n${BOLD}${relativePath}${RESET}`);
  }

  onTestCaseResult(testCase: TestCase): void {
    const result = testCase.result();
    const name = testCase.name;

    switch (result.state) {
      case "passed": {
        this.counts.pass++;
        const diag = testCase.diagnostic();
        const duration = diag ? ` (${formatDuration(diag.duration)})` : "";
        console.log(`  ${GREEN}\u2713${RESET} ${name}${GRAY}${duration}${RESET}`);
        break;
      }
      case "failed": {
        this.counts.fail++;
        console.log(`  ${RED}\u2717${RESET} ${name}`);
        if (result.errors && result.errors.length > 0) {
          const err = result.errors[0];
          const msg = stripStack(err.message ?? "Unknown error");
          const errType = classifyError(msg);
          console.log(`    ${RED}${err.name ?? "Error"}: ${msg} (${errType})${RESET}`);
        }
        break;
      }
      case "skipped": {
        // Check if this is an "unavailable" skip (service not reachable)
        // vs a "skip" (missing API key / env var not set)
        const note = result.note ?? "";
        const isUnavailable = /unavailable/i.test(note);
        if (isUnavailable) {
          this.counts.unavailable++;
          console.log(
            `  ${GRAY}\u25CC${RESET} ${name}${note ? ` ${GRAY}\u2014 ${note}${RESET}` : ""}`,
          );
        } else {
          this.counts.skip++;
          console.log(
            `  ${YELLOW}\u25CB${RESET} ${name}${note ? ` ${YELLOW}\u2014 ${note}${RESET}` : ""}`,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  onTestRunEnd(
    _testModules: ReadonlyArray<TestModule>,
    _unhandledErrors: ReadonlyArray<SerializedError>,
    _reason: TestRunEndReason,
  ): void {
    const totalDuration = Date.now() - this.startTime;
    const { pass, fail, skip, unavailable } = this.counts;
    const total = pass + fail + skip + unavailable;

    const separator = "\u2500".repeat(37);
    console.log(`\n${separator}`);
    console.log(`${BOLD}Live Test Summary${RESET}`);
    console.log("");
    console.log(`  ${GREEN}Pass:${RESET}        ${pass}`);
    if (fail > 0) {
      console.log(`  ${RED}Fail:${RESET}        ${fail}`);
    } else {
      console.log(`  Fail:        ${fail}`);
    }
    if (skip > 0) {
      console.log(`  ${YELLOW}Skip:${RESET}        ${skip}`);
    } else {
      console.log(`  Skip:        ${skip}`);
    }
    console.log(`  Unavailable: ${unavailable}`);
    console.log(`  Total:       ${total}`);
    console.log(`  Duration:    ${formatDuration(totalDuration)}`);

    // Collect missing keys
    const missingEntries: Array<{ key: string; files: string[] }> = [];
    for (const [label, entry] of Object.entries(LIVE_TEST_KEY_MAP)) {
      const allMissing = entry.keys.every((k) => !process.env[k]);
      if (allMissing) {
        missingEntries.push({ key: label, files: entry.files });
      }
    }

    if (missingEntries.length > 0) {
      console.log("");
      console.log(`${YELLOW}Missing Keys (set these to enable more tests):${RESET}`);
      console.log("");
      for (const { key, files } of missingEntries) {
        console.log(`  ${BOLD}${key}${RESET}`);
        for (const file of files) {
          console.log(`    \u2192 ${file}`);
        }
        console.log("");
      }
    }

    console.log(separator);
  }
}

export default LiveTestReporter;
