import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const helper = "scripts/e2e/lib/onboard/first-agent-flow.sh";

describe.skipIf(process.platform === "win32")("guided first-agent prompt handshake", () => {
  it.each([
    ["legacy", "plain", 5],
    ["legacy", "fragmented", 5],
    ["team", "plain", 6],
    ["team", "fragmented", 6],
  ] as const)("drives the real guided sender through %s %s prompts", (layout, rendering, count) => {
    const root = dirs.make("onboard-first-agent-flow-");
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
export OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY=1
export OPENCLAW_ONBOARD_E2E_TMPDIR="$CASE_ROOT"
source scripts/e2e/lib/onboard/scenario.sh
trap 'rm -rf "$ONBOARD_TMP_DIR"' EXIT
WIZARD_LOG_PATH="$CASE_ROOT/prompts.log"
export WIZARD_LOG_PATH
prompts=("Help make OpenClaw better?")
if [[ "$LAYOUT" == team ]]; then
  prompts+=($'\\e[36mWhat would you like to create?\\e[39m\\n● One agent\\n○ A small team')
fi
prompts+=("What should we call your first agent?" "How should I set things up?" "Model/auth provider" "Use which detected AI?")
index=0
render() {
  "$NODE_BIN" -e 'const fs=require("node:fs"); const text=process.argv[2]; fs.writeFileSync(process.argv[1], process.env.RENDERING === "fragmented" ? text.split("").join("\\n") : text);' "$WIZARD_LOG_PATH" "$1"
}
# The terminal is the boundary double. Prompt recognition and the production
# sender are real; unexpected keystrokes or out-of-order waits fail immediately.
wait_for_log() {
  if ! log_contains "$1"; then
    printf 'unexpected wait: %s\\n' "$1" >&2
    return 21
  fi
}
send() {
  [[ "$1" == $'\\r' ]] || { echo 'unexpected keystroke' >&2; return 22; }
  index=$((index + 1))
  render "\${prompts[$index]:-DONE}"
}
render "\${prompts[0]}"
send_guided_skip_ui_flow
[[ "$index" == "\${#prompts[@]}" ]]
printf 'responses=%s\\n' "$index"
`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CASE_ROOT: root,
          LAYOUT: layout,
          RENDERING: rendering,
          NODE_BIN: process.execPath,
        },
        timeout: 10_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`responses=${count}`);
  });

  it.each([
    ["incomplete", 0],
    ["menu", 1],
  ] as const)("does not send blindly or re-answer a stalled %s state", (mode, expectedInputs) => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
source ${helper}
count=0
contains() {
  case "$1" in
    'What would you like to create?') return 0 ;;
    'One agent') [[ "$MODE" == menu ]] ;;
    *) return 1 ;;
  esac
}
send() { count=$((count + 1)); }
wait_for_first_agent_prompt contains 1 0
status=$?
printf 'inputs=%s\\n' "$count"
exit "$status"
`,
      ],
      { encoding: "utf8", env: { ...process.env, MODE: mode }, timeout: 5_000 },
    );
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe(`inputs=${expectedInputs}`);
    expect(result.stderr).toContain("Timeout waiting for first-agent prompt");
  });
});
