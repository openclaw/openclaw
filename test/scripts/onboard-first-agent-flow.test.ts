import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const test = it.skipIf(process.platform === "win32");
const run = (script: string, env: NodeJS.ProcessEnv, timeout = 10_000) =>
  spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    timeout,
    env: { ...process.env, NODE_BIN: process.execPath, ...env },
  });

test.each([
  ["legacy", "plain", "provider", 5],
  ["team", "fragmented", "provider", 6],
  ["legacy", "fragmented", "configured", 4],
  ["team", "plain", "configured", 5],
] as const)("guided sender: %s / %s / %s", (layout, rendering, modelPrompt, count) => {
  const result = run(
    `
export OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY=1 OPENCLAW_ONBOARD_E2E_TMPDIR="$CASE_ROOT"
source scripts/e2e/lib/onboard/scenario.sh
export WIZARD_LOG_PATH="$CASE_ROOT/prompts.log"
prompts=("Help make OpenClaw better?")
[[ "$LAYOUT" != team ]] || prompts+=($'\\e[36mWhat would you like to create?\\e[39m\\n● One agent\\n○ A small team')
prompts+=("What should we call your first agent?" "How should I set things up?")
case "$MODEL_PROMPT" in
  configured) prompts+=("Use Current model?") ;;
  *) prompts+=("Model/auth provider" "Use which detected AI?") ;;
esac
index=0
render() {
  "$NODE_BIN" -e 'const fs=require("node:fs"); const text=process.argv[2]; fs.writeFileSync(process.argv[1], process.env.RENDERING === "fragmented" ? text.split("").join("\\n") : text);' "$WIZARD_LOG_PATH" "$1"
}
wait_for_log() { log_contains "$1"; }
send() {
  [[ "$1" == $'\\r' ]] || { echo 'unexpected keystroke' >&2; return 22; }
  index=$((index + 1))
  render "\${prompts[$index]:-DONE}"
}
render "\${prompts[0]}"
send_guided_skip_ui_flow
printf 'responses=%s\\n' "$index"
`,
    {
      CASE_ROOT: dirs.make("onboard-first-agent-flow-"),
      LAYOUT: layout,
      MODEL_PROMPT: modelPrompt,
      RENDERING: rendering,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(`responses=${count}`);
});

test.each([
  ["incomplete", 0],
  ["menu", 1],
] as const)("does not send blindly or re-answer a stalled %s state", (mode, expectedInputs) => {
  const result = run(
    `
source scripts/e2e/lib/onboard/first-agent-flow.sh
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
    { MODE: mode },
    5_000,
  );
  expect(result.status).toBe(1);
  expect(result.stdout.trim()).toBe(`inputs=${expectedInputs}`);
  expect(result.stderr).toContain("Timeout waiting for first-agent prompt");
});
