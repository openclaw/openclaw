#!/usr/bin/env bash
set -euo pipefail

pnpm exec vitest run src/gateway/tools-invoke-http.test.ts \
  -t "does not record Gateway tools.invoke calls in agent tool-loop history"
