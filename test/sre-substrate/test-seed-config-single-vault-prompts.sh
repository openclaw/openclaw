#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/skills/morpho-sre"
CONFIG="$ROOT/config/openclaw.json"

jq -e '
  [
    .channels.slack.channels["#platform-monitoring"].systemPrompt,
    .channels.slack.channels["#staging-infra-monitoring"].systemPrompt,
    .channels.slack.channels["#public-api-monitoring"].systemPrompt
  ] as $prompts
  | ($prompts | unique | length == 1)
    and ($prompts | all(contains("Keep that 4-line incident header on every follow-up update")))
    and ($prompts | all(contains("If new evidence disproves an earlier theory, state that directly in the next update")))
    and ($prompts | all(contains("For one-address GraphQL / `sentryEventId` / `traceId` incidents")))
    and ($prompts | all(contains("single-vault-graphql-evidence.sh when possible")))
    and ($prompts | all(contains("Do not call an ingestion/provenance root cause confirmed for a single-vault GraphQL incident")))
' "$CONFIG" >/dev/null
