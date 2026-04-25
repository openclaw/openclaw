# midday check - 2026-04-25

## open PRs

| PR     | title                                                                     | last updated | status             |
| ------ | ------------------------------------------------------------------------- | ------------ | ------------------ |
| #66225 | fix(agents): align final tag regexes for `<final/>`                       | 2026-04-23   | waiting for review |
| #66544 | fix(gateway): exclude heartbeat sender ID from session display name       | 2026-04-23   | waiting for review |
| #68446 | fix(whatsapp): stop DM allowFrom fallback into group policy sender bypass | 2026-04-24   | waiting for review |
| #69685 | fix(agents): strip final tags from persisted assistant message            | 2026-04-23   | waiting for review |

MCP is restricted to suboss87/openclaw for writes, so couldn't fetch PR comments via API. No human feedback retrieved this run.

## bug hunt

Picked #71474 - LM Studio model names with `@` quant specifiers (e.g. `lmstudio/qwen3-27b@q4_k_xl`) get silently truncated. Two symptoms:

- `/model lmstudio/qwen3-27b@q4_k_xl` returns "model not allowed: lmstudio/qwen3-27b"
- requests to LM Studio use the truncated model ID, causing random quant selection

**root cause:** `splitTrailingAuthProfile` treats the first `@` after the last `/` as an auth-profile separator, stripping `@q4_k_xl` before the allowlist check.

**fix:** `resolveAllowedModelRef` now tries the full raw string as a model key first (via `parseModelRef`, no splitting). If that key is in the configured allowlist, returns it immediately. Falls through to profile-split path otherwise - so `openai/gpt-5@work` with allowlist entry `openai/gpt-5` still works correctly.

Branch pushed: `suboss87:fix/lmstudio-at-model-name` (commit a2c58ef)
54/54 model-selection tests pass including 2 new regression tests.

**action needed:** open PR against openclaw/openclaw manually via GitHub web UI (MCP write access limited to fork only).

## actions this run

- detected #71422 (avatar regression) already covered by competing PR #71464 - skipped
- detected #71474 (LM Studio @ quants) - zero competing PRs, clear repro, fixed
- all 4 open PRs unchanged - no fresh human feedback retrieved

## escalations

none
