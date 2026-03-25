#!/usr/bin/env bash
#
# run-evals.sh — Eval runner for affiliate-skills
#
# Runs test cases from evals/evals.json against an LLM, checks expected patterns.
# Usage:
#   ./scripts/run-evals.sh                     # Run all evals
#   ./scripts/run-evals.sh affiliate-program-search  # Run one skill's evals
#   ./scripts/run-evals.sh --dry-run           # Show what would run without invoking model
#
# Requires: jq, claude (Claude CLI)
# Optional: EVAL_MODEL (default: sonnet), EVAL_TIMEOUT (default: 120s)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
EVALS_FILE="$REPO_DIR/evals/evals.json"
RESULTS_DIR="$REPO_DIR/evals/results"

MODEL="${EVAL_MODEL:-sonnet}"
TIMEOUT="${EVAL_TIMEOUT:-120}"
DRY_RUN=false
FILTER=""
VERBOSE=false

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

usage() {
  echo "Usage: $0 [OPTIONS] [SKILL_SLUG]"
  echo ""
  echo "Options:"
  echo "  --dry-run     Show test cases without running them"
  echo "  --verbose     Show full model output for each test"
  echo "  --model NAME  Override model (default: sonnet)"
  echo "  -h, --help    Show this help"
  echo ""
  echo "Examples:"
  echo "  $0                              # Run all evals"
  echo "  $0 viral-post-writer            # Run one skill"
  echo "  $0 --dry-run                    # Preview tests"
  echo "  $0 --model opus viral-post-writer  # Use opus model"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)  DRY_RUN=true; shift ;;
    --verbose)  VERBOSE=true; shift ;;
    --model)    MODEL="$2"; shift 2 ;;
    -h|--help)  usage; exit 0 ;;
    *)          FILTER="$1"; shift ;;
  esac
done

# Check dependencies
if ! command -v jq &> /dev/null; then
  echo -e "${RED}Error: jq is required but not installed. Run: brew install jq${NC}"
  exit 1
fi

if ! command -v claude &> /dev/null; then
  echo -e "${RED}Error: claude CLI is required. Install from https://claude.ai/cli${NC}"
  exit 1
fi

if [[ ! -f "$EVALS_FILE" ]]; then
  echo -e "${RED}Error: $EVALS_FILE not found${NC}"
  exit 1
fi

mkdir -p "$RESULTS_DIR"

# Get skill list
if [[ -n "$FILTER" ]]; then
  SKILLS=$(jq -r ".skills | keys[]" "$EVALS_FILE" | grep "$FILTER" || true)
  if [[ -z "$SKILLS" ]]; then
    echo -e "${RED}No skills matching '$FILTER' found in evals.json${NC}"
    exit 1
  fi
else
  SKILLS=$(jq -r ".skills | keys[]" "$EVALS_FILE")
fi

TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_SKIP=0
TOTAL_TESTS=0
RESULTS_LOG="$RESULTS_DIR/run-$(date +%Y%m%d-%H%M%S).json"

echo -e "${CYAN}═══════════════════════════════════════════${NC}"
echo -e "${CYAN}  Affiliate Skills Eval Runner${NC}"
echo -e "${CYAN}  Model: $MODEL | Timeout: ${TIMEOUT}s${NC}"
echo -e "${CYAN}═══════════════════════════════════════════${NC}"
echo ""

# JSON results array
echo '{"run_at": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'", "model": "'$MODEL'", "results": [' > "$RESULTS_LOG"
FIRST_RESULT=true

for SKILL in $SKILLS; do
  SKILL_PATH="$REPO_DIR/skills"
  # Find the skill directory
  SKILL_DIR=$(find "$SKILL_PATH" -name "$SKILL" -type d 2>/dev/null | head -1)

  if [[ -z "$SKILL_DIR" ]]; then
    echo -e "${YELLOW}⚠ Skill directory not found for: $SKILL${NC}"
    continue
  fi

  SKILL_MD="$SKILL_DIR/SKILL.md"
  TEST_COUNT=$(jq -r ".skills[\"$SKILL\"].tests | length" "$EVALS_FILE")

  echo -e "${CYAN}── $SKILL ($TEST_COUNT tests) ──${NC}"

  for i in $(seq 0 $((TEST_COUNT - 1))); do
    TEST_ID=$(jq -r ".skills[\"$SKILL\"].tests[$i].id" "$EVALS_FILE")
    TEST_NAME=$(jq -r ".skills[\"$SKILL\"].tests[$i].name" "$EVALS_FILE")
    INPUT=$(jq -r ".skills[\"$SKILL\"].tests[$i].input_prompt" "$EVALS_FILE")
    PATTERNS=$(jq -r ".skills[\"$SKILL\"].tests[$i].expected_patterns[]" "$EVALS_FILE")

    TOTAL_TESTS=$((TOTAL_TESTS + 1))

    if $DRY_RUN; then
      echo -e "  ${YELLOW}○${NC} $TEST_ID: $TEST_NAME"
      echo "    Input: $INPUT"
      echo "    Patterns: $(echo "$PATTERNS" | tr '\n' ', ')"
      TOTAL_SKIP=$((TOTAL_SKIP + 1))
      continue
    fi

    echo -ne "  ◌ $TEST_ID: $TEST_NAME..."

    # Build the prompt: load skill + run the test
    PROMPT="You are an AI executing an affiliate marketing skill. Read the skill instructions below, then respond to the user prompt.

--- SKILL INSTRUCTIONS ---
$(cat "$SKILL_MD")
--- END SKILL ---

USER PROMPT: $INPUT

Execute the skill now. Produce the full output as specified in the skill's Output Format section."

    # Run the model
    OUTPUT_FILE="$RESULTS_DIR/${TEST_ID}.txt"
    if timeout "${TIMEOUT}s" claude --model "$MODEL" --print --no-input "$PROMPT" > "$OUTPUT_FILE" 2>/dev/null; then
      # Check patterns
      PASS=true
      MISSING=""
      for PATTERN in $PATTERNS; do
        if ! grep -qi "$PATTERN" "$OUTPUT_FILE" 2>/dev/null; then
          PASS=false
          MISSING="$MISSING $PATTERN"
        fi
      done

      if $PASS; then
        echo -e "\r  ${GREEN}✓${NC} $TEST_ID: $TEST_NAME"
        TOTAL_PASS=$((TOTAL_PASS + 1))
        STATUS="pass"
      else
        echo -e "\r  ${RED}✗${NC} $TEST_ID: $TEST_NAME"
        echo -e "    ${RED}Missing patterns:${MISSING}${NC}"
        TOTAL_FAIL=$((TOTAL_FAIL + 1))
        STATUS="fail"
      fi

      if $VERBOSE; then
        echo "    ── Output (first 500 chars) ──"
        head -c 500 "$OUTPUT_FILE" | sed 's/^/    /'
        echo ""
        echo "    ── End ──"
      fi
    else
      echo -e "\r  ${YELLOW}⚠${NC} $TEST_ID: $TEST_NAME (timeout or error)"
      TOTAL_SKIP=$((TOTAL_SKIP + 1))
      STATUS="error"
      MISSING="timeout"
    fi

    # Append to JSON log
    if ! $FIRST_RESULT; then echo ',' >> "$RESULTS_LOG"; fi
    FIRST_RESULT=false
    cat >> "$RESULTS_LOG" <<JSONEOF
  {"id": "$TEST_ID", "skill": "$SKILL", "name": "$TEST_NAME", "status": "$STATUS", "missing": "$(echo $MISSING | xargs)"}
JSONEOF
  done
  echo ""
done

# Close JSON
echo ']}' >> "$RESULTS_LOG"

echo -e "${CYAN}═══════════════════════════════════════════${NC}"
echo -e "  Results: ${GREEN}$TOTAL_PASS passed${NC} | ${RED}$TOTAL_FAIL failed${NC} | ${YELLOW}$TOTAL_SKIP skipped${NC} | $TOTAL_TESTS total"

if [[ $TOTAL_FAIL -gt 0 ]]; then
  echo -e "  ${RED}Some tests failed. Check $RESULTS_DIR/ for outputs.${NC}"
fi

if $DRY_RUN; then
  echo -e "  ${YELLOW}(dry run — no tests were executed)${NC}"
fi

echo -e "  Log: $RESULTS_LOG"
echo -e "${CYAN}═══════════════════════════════════════════${NC}"

# Exit code: non-zero if any failures
[[ $TOTAL_FAIL -eq 0 ]]
