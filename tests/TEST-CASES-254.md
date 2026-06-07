# Test Cases: nova-openclaw#254 — Gateway Boot-Time Plugin Discovery Logging
<!-- Issue: #254 | Workflow run: 19 | Designed by: Gem (QA Lead) | Step 3 -->

## Problem Statement

When the gateway starts, the `openclaw plugins list` command surfaces extension state (including `"plugin disabled (not in allowlist) but config is present"` warnings). However, the **gateway boot logs** emit nothing about which plugins were discovered, loaded, or skipped — and for what reason.

This means silent misconfiguration: on peer hosts (Newhart, Graybeard) where `plugins.allow` is non-empty and `agent_config_sync` was not in the list, the plugin never loaded and the operator had no boot-time signal that anything was wrong.

**Fix required:** During gateway startup, emit exactly **one structured INFO log line** that summarizes:
- Total discovered extensions
- IDs of loaded extensions
- IDs of skipped extensions, each with a reason string

The log line should be emitted at `INFO` level (not `DEBUG`) so it appears in normal operation logs.

---

## Implementation Surface

The log should be added to the gateway startup path in one of:
- `src/plugins/loader.ts` — after the plugin load cycle completes
- `src/plugins/gateway-startup-plugin-ids.ts` — in the startup plugin plan resolution
- A new `src/plugins/gateway-startup-extension-log.ts` helper

The test file should be co-located: `src/plugins/gateway-startup-extension-log.test.ts` (new)  
OR tests can be added to `src/plugins/loader.test.ts` in a new describe block.

Framework: **Vitest** (consistent with all existing plugin tests)

---

## Test Cases

### TC-254-01: No plugins discovered — log reports zero counts

**Asserts:** When the extensions directory is empty and no plugins are configured, the startup log emits a discovery summary with all-zero counts.

**Setup:**
- Config: `{ plugins: { entries: {}, allow: [] } }`
- No plugins discovered (mock `discoverOpenClawPlugins` returns `{ candidates: [], diagnostics: [] }`)
- Gateway startup proceeds normally

**Action:** Trigger the gateway plugin load cycle; capture log output

**Expected:**
- Exactly one INFO log line emitted with label matching `[plugins] startup` or `[plugins] extension discovery` (exact label TBD by implementer, but must be a named subsystem)
- Log line fields include: `discovered: 0`, `loaded: 0`, `skipped: 0`
- `skipped` array is empty
- Log level is INFO (not debug, not warn)

**Type:** unit (Vitest) | **File:** `src/plugins/gateway-startup-extension-log.test.ts`

---

### TC-254-02: All discovered plugins loaded successfully — log lists all loaded IDs

**Asserts:** When all discovered plugins pass allowlist + manifest checks and load successfully, log reflects the full loaded set.

**Setup:**
- 3 plugins discovered: `["discord", "telegram", "agent_config_sync"]`
- Config: `{ plugins: { allow: [] } }` (empty allow = default-allow)
- All 3 plugins load without error

**Action:** Run gateway startup plugin load cycle

**Expected:**
- Log line: `discovered: 3`, `loaded: 3`, `skipped: 0`
- `loaded` array contains all three IDs (order may vary)
- `skipped` array is empty or absent

**Type:** unit (Vitest) | **File:** `src/plugins/gateway-startup-extension-log.test.ts`

---

### TC-254-03: Mixed result — some loaded, some skipped — log correctly partitions

**Asserts:** When a non-empty `plugins.allow` causes some plugins to be blocked, the log correctly separates loaded from skipped.

**Setup:**
- 4 plugins discovered: `["discord", "telegram", "agent_config_sync", "someplugin"]`
- Config: `{ plugins: { allow: ["discord", "telegram"] } }` (non-empty allowlist)
- `discord` and `telegram` → loaded
- `agent_config_sync` and `someplugin` → skipped (not in allowlist)

**Action:** Run gateway startup plugin load cycle

**Expected:**
- Log line: `discovered: 4`, `loaded: 2`, `skipped: 2`
- `loaded` array: `["discord", "telegram"]` (in any order)
- `skipped` array: each entry has `{ id: "agent_config_sync", reason: "not in allowlist" }` and `{ id: "someplugin", reason: "not in allowlist" }` (exact reason string TBD by implementer, but must be human-readable)

**Type:** unit (Vitest) | **File:** `src/plugins/gateway-startup-extension-log.test.ts`

---

### TC-254-04: Plugin disabled via `plugins.entries[id].enabled = false` — appears in skipped with reason

**Asserts:** Explicitly disabled plugins are reported in the startup log as skipped with reason `"disabled in config"` (or equivalent).

**Setup:**
- 2 plugins discovered: `["agent_config_sync", "discord"]`
- Config:
  ```json
  {
    "plugins": {
      "allow": [],
      "entries": { "agent_config_sync": { "enabled": false } }
    }
  }
  ```
- `discord` → loaded
- `agent_config_sync` → skipped (explicitly disabled)

**Action:** Run gateway startup plugin load cycle

**Expected:**
- Log line: `discovered: 2`, `loaded: 1`, `skipped: 1`
- `skipped` entry for `agent_config_sync` includes reason indicating explicit disable (e.g. `"disabled in config"`)
- `discord` appears in `loaded`

**Type:** unit (Vitest) | **File:** `src/plugins/gateway-startup-extension-log.test.ts`

---

### TC-254-05: Plugin fails manifest validation — appears in skipped with reason

**Asserts:** A plugin whose `openclaw.plugin.json` fails schema validation is reported as skipped with reason `"manifest validation failed"` (or equivalent), NOT silently dropped.

**Setup:**
- 2 plugins discovered: `["good-plugin", "bad-manifest-plugin"]`
- `bad-manifest-plugin` has an invalid/malformed `openclaw.plugin.json`
- `good-plugin` manifest is valid and plugin loads successfully
- Config: `{ plugins: { allow: [] } }`

**Action:** Run gateway startup plugin load cycle

**Expected:**
- Log line: `discovered: 2`, `loaded: 1`, `skipped: 1`
- `skipped` entry for `bad-manifest-plugin` includes reason indicating manifest failure (e.g. `"manifest validation failed"` or `"invalid manifest"`)
- `good-plugin` appears in `loaded`
- No unhandled exception is thrown

**Type:** unit (Vitest) | **File:** `src/plugins/gateway-startup-extension-log.test.ts`

---

### TC-254-06: Plugin in allowlist but `enabled = false` in config — reports as disabled (not allowlist)

**Asserts:** When a plugin IS in `plugins.allow` but has `enabled: false` in entries, the skip reason is `"disabled in config"`, not `"not in allowlist"`. Reason specificity matters.

**Setup:**
- 1 plugin discovered: `["agent_config_sync"]`
- Config:
  ```json
  {
    "plugins": {
      "allow": ["agent_config_sync"],
      "entries": { "agent_config_sync": { "enabled": false } }
    }
  }
  ```

**Action:** Run gateway startup plugin load cycle

**Expected:**
- Log line: `discovered: 1`, `loaded: 0`, `skipped: 1`
- Skipped reason for `agent_config_sync` is `"disabled in config"` (or equivalent), NOT `"not in allowlist"`

**Type:** unit (Vitest) | **File:** `src/plugins/gateway-startup-extension-log.test.ts`

---

### TC-254-07: Log is emitted exactly once per gateway startup

**Asserts:** The startup discovery log line is emitted exactly once during a single gateway boot cycle, regardless of plugin count.

**Setup:**
- 3 plugins, 2 loaded, 1 skipped (any valid mixed scenario)
- Log output captured via spy

**Action:** Run full gateway startup plugin load cycle once

**Expected:**
- The startup discovery log line is emitted exactly **1 time**
- Subsequent plugin operations (hot reload, incremental loads) do NOT emit the startup summary again

**Type:** unit (Vitest) | **File:** `src/plugins/gateway-startup-extension-log.test.ts`

---

### TC-254-08: Log is emitted at INFO level (appears in normal gateway output)

**Asserts:** The startup log message uses INFO level, not DEBUG or WARN. DEBUG messages are typically suppressed in production logging; WARN implies a problem. This is a routine summary, so it must be INFO.

**Setup:**
- Any valid startup scenario (e.g., 2 plugins discovered, 2 loaded)
- Logger spy that captures level alongside message

**Action:** Run gateway startup plugin load cycle; inspect log record

**Expected:**
- The captured log record has `level === "info"` (or the equivalent INFO constant)
- NOT `level === "debug"`, NOT `level === "warn"`, NOT `level === "error"`

**Type:** unit (Vitest) | **File:** `src/plugins/gateway-startup-extension-log.test.ts`

---

### TC-254-09: Skipped-due-to-allowlist plugin shows `config is present` context (regression coverage)

**Asserts:** The specific scenario that triggered this issue — plugin config present in `plugins.entries` but plugin not in `plugins.allow` — is captured in the startup log, not only in `openclaw plugins list`.

**Setup:**
- 1 plugin discovered: `agent_config_sync`
- Config:
  ```json
  {
    "plugins": {
      "allow": ["discord"],
      "entries": {
        "agent_config_sync": { "enabled": true, "config": { "database": "nova_memory" } }
      }
    }
  }
  ```
- `agent_config_sync` has explicit config but is NOT in allowlist

**Action:** Run gateway startup plugin load cycle; capture log output

**Expected:**
- Log emits at startup: `agent_config_sync` in `skipped` with reason `"not in allowlist"` (and optionally `"config is present"` as extra context)
- This info is visible in the **gateway boot log** — NOT requiring `openclaw plugins list` to surface it

**Type:** unit (Vitest) | **File:** `src/plugins/gateway-startup-extension-log.test.ts`

---

## Pass/Fail Criteria Summary

| TC | Scenario | Pass Condition |
|---|---|---|
| TC-254-01 | No plugins | `discovered:0, loaded:0, skipped:0` in log |
| TC-254-02 | All loaded | All IDs in `loaded`, `skipped` empty |
| TC-254-03 | Mixed loaded+skipped | Correct partition, reasons = `"not in allowlist"` |
| TC-254-04 | Plugin `enabled: false` | `skipped` with reason `"disabled in config"` |
| TC-254-05 | Manifest validation failure | `skipped` with reason `"manifest validation failed"` |
| TC-254-06 | In allowlist but disabled — correct reason | Reason is `"disabled in config"`, NOT allowlist |
| TC-254-07 | Log emitted exactly once per boot | Single log entry per startup cycle |
| TC-254-08 | Log at INFO level | `level === "info"` |
| TC-254-09 | Regression: config present + not in allowlist | Visible at boot, not just `plugins list` |

**Total: 9 test cases** covering all five gateway plugin scenarios (no plugins, all loaded, mixed, manifest failure, disabled-by-config) plus level/frequency/regression-specific cases.

---

## Notes for Coder

1. **Log format:** The exact JSON/text shape of the log line is left to implementer discretion, but must include: `discovered` (count), `loaded` (array of IDs), `skipped` (array of `{id, reason}` objects). All three fields are required.

2. **Subsystem name:** Use a stable subsystem label like `"plugins/startup"` or `"plugins"` so operators can grep/filter reliably. Document the chosen subsystem label in a code comment.

3. **Test file location:** `src/plugins/gateway-startup-extension-log.test.ts` (new). If the implementation is co-located in an existing file (e.g., `loader.ts`), add the tests to an existing test file in a new `describe` block named `"gateway startup extension discovery log"`.

4. **Logger spy pattern:** Existing tests use `createSubsystemLogger`; spy on its output or inject a mock logger. Follow the pattern established in `loader.test.ts` lines 960-1020.
