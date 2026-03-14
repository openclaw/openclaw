# SMT-LIB2 Tool Policy Verification

Formal verification module that generates SMT-LIB2 models from OpenClaw's tool policy source code, enabling Z3-based checking of security properties.

## What It Does

The `src/verify/` module reads the following TypeScript source files using the TypeScript Compiler API (AST walking, no regex):

| Source file                          | What's extracted                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `src/agents/tool-catalog.ts`         | `CORE_TOOL_DEFINITIONS` (25 tools, section groups, profiles, openclaw group), `CORE_TOOL_SECTION_ORDER` |
| `src/agents/tool-policy-shared.ts`   | `TOOL_NAME_ALIASES` (e.g. `bash` -> `exec`, `apply-patch` -> `apply_patch`)                             |
| `src/agents/tool-policy.ts`          | `OWNER_ONLY_TOOL_NAME_FALLBACKS` (tools restricted to owner sender)                                     |
| `src/agents/pi-tools.policy.ts`      | `SUBAGENT_TOOL_DENY_ALWAYS`, `SUBAGENT_TOOL_DENY_LEAF`                                                  |
| `src/agents/tool-policy-pipeline.ts` | `buildDefaultToolPolicyPipelineSteps` (7-step filtering pipeline)                                       |

From this parsed data, it generates 6 SMT-LIB2 model files:

| Output file             | Contents                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `model/tools.smt2`      | Tool universe as an enumerated datatype, aliases, section groups, glob helpers       |
| `model/pipeline.smt2`   | 7-step pipeline survival semantics (allow/deny per step, `apply_patch` special case) |
| `model/profiles.smt2`   | Profile presets (minimal, coding, messaging, full) with subset relationships         |
| `model/owner-only.smt2` | Owner-only post-pipeline gate (`passes_owner_gate`)                                  |
| `model/subagent.smt2`   | Subagent deny list (flat), deny-first gate, optional allow-list filter               |
| `model/all.smt2`        | Combined loader that includes all components in dependency order                     |

Each generated `.smt2` file includes inline smoke tests (push/pop assertions with expected `unsat` results).

## Architecture

```
src/verify/
├── types.ts                   # Shared types: ToolDefinition, ParsedPolicies, PipelineStep, etc.
├── parse-tools.ts             # AST parser for tool-catalog.ts
├── parse-policies.ts          # AST parser for policy files (aliases, owner-only, subagent deny)
├── parse-pipeline.ts          # AST parser for tool-policy-pipeline.ts
├── generate-smt.ts            # CLI entry point: parse -> generate -> optionally verify with Z3
├── emit-smt/
│   ├── tools.ts               # Emitter for tools.smt2
│   ├── pipeline.ts            # Emitter for pipeline.smt2
│   ├── profiles.ts            # Emitter for profiles.smt2
│   ├── owner-only.ts          # Emitter for owner-only.smt2
│   ├── subagent.ts            # Emitter for subagent.smt2
│   └── properties.ts          # Emitter for all.smt2 + property file copier (P1-P6)
└── __tests__/
    ├── parse-tools.test.ts    # Vitest tests (12 assertions)
    └── run-tests.ts           # Standalone test runner (no vitest dependency)
```

## Security Properties (P1-P6)

The generator can copy 6 property files from a reference directory (`../openclaw-tool-policy-z3/properties/`) containing 32 total Z3 checks:

- **P1** — Dangerous bypass: ensures dangerous tools can't bypass deny lists
- **P2** — Deny dominance: deny always overrides allow at each pipeline step
- **P3** — Stripping soundness: `stripPluginOnlyAllowlist` doesn't leak core tool access
- **P4** — Subagent containment: subagent deny lists are enforced correctly
- **P5** — Profile monotonicity: minimal ⊆ coding ⊆ messaging ⊆ full
- **P6** — Owner-only completeness: owner-only tools are blocked for non-owners

## How to Test

### 1. Run the Vitest unit tests (12 parser tests)

```bash
pnpm test src/verify/__tests__/parse-tools.test.ts
```

This validates that the AST parsers correctly extract:

- All 25 tool definitions with correct ids, sections, profiles, and openclaw group membership
- Tool name aliases (`bash` -> `exec`, `apply-patch` -> `apply_patch`)
- Owner-only fallback list (gateway, cron, whatsapp_login, etc.)
- Subagent deny list
- All 7 pipeline steps with `stripPluginOnlyAllowlist: true`

### 2. Run the standalone test runner (no vitest needed)

```bash
npx tsx src/verify/__tests__/run-tests.ts
```

Same checks as above but self-contained (useful in CI or environments without vitest).

### 3. Generate the SMT-LIB2 model files

```bash
npx tsx src/verify/generate-smt.ts --output-dir ./verify-output
```

This parses the source and writes 6 `.smt2` files to `./verify-output/model/`. Inspect the output to confirm the generated SMT matches your expectations.

### 4. Verify with Z3 (requires Z3 installed)

```bash
# Install Z3 if needed
brew install z3   # macOS
# or: apt-get install z3

# Generate + verify in one step
npx tsx src/verify/generate-smt.ts --output-dir ./verify-output --verify
```

The `--verify` flag runs `z3 all.smt2` on the combined model. All smoke tests should return `unsat`. If property files exist in the reference directory (`../openclaw-tool-policy-z3/properties/`), it also runs `run-all.sh` to check all 32 security properties.

### 5. Verify individual model files with Z3

```bash
cd verify-output/model
z3 tools.smt2        # Should print "tools.smt2 loaded successfully"
z3 all.smt2          # Loads all models; smoke tests should all return unsat
```

Each file's smoke tests use push/pop scopes and expect `unsat` for their assertions, confirming the model is internally consistent.

## Counter Examples

The Vitest suite documents expectations for the parsed tool metadata. The snippets below show what currently **passes** the tests versus intentionally broken variants that those tests would catch.

> **Scope note:** These tests catch _accidental_ regressions — a developer changing a constant without realizing the security implications. They do not protect against adversarial source modifications (an attacker who can edit source code can also edit the tests). The real security value comes from the Z3 property checks (P1-P6), which prove invariants over the _generated model_ rather than spot-checking individual constants.

### Tool catalog extraction

```ts
// ✅ src/agents/tool-catalog.ts (passes parseToolCatalog tests)
const CORE_TOOL_DEFINITIONS: CoreToolDefinition[] = [
  {
    id: "read",
    label: "read",
    description: "Read file contents",
    sectionId: "fs",
    profiles: ["coding"],
    includeInOpenClawGroup: false,
  },
  {
    id: "exec",
    label: "exec",
    description: "Run shell commands",
    sectionId: "runtime",
    profiles: ["coding"],
  },
  {
    id: "browser",
    label: "browser",
    description: "Control web browser",
    sectionId: "ui",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  // …remaining 22 tool definitions…
];
```

```ts
// ❌ Counter example: fails parseToolCatalog assertions
const CORE_TOOL_DEFINITIONS: CoreToolDefinition[] = [
  {
    id: "read",
    sectionId: "runtime", // expected "fs"
    profiles: ["messaging"], // expected ["coding"]
    includeInOpenClawGroup: true, // expected false
  },
  {
    id: "browser",
    sectionId: "web", // expected "ui"
    includeInOpenClawGroup: false, // expected true
  },
];
```

The failing version violates the section (`read` should be `"fs"`), profile (`read` should be `"coding"`), and OpenClaw group membership expectations (`browser` must stay `true`, `read` must stay `false`). The `parseToolCatalog` tests would flag every deviation.

Why this matters: the SMT model treats `CORE_TOOL_DEFINITIONS` as the canonical source of each tool's section, profile, and group membership. If someone accidentally moved `read` into the messaging profile, messaging-only channels would inherit filesystem access. These tests catch such regressions before they propagate into the SMT model.

### Tool name normalization (aliases)

```ts
// ✅ src/agents/tool-policy-shared.ts
const TOOL_NAME_ALIASES: Record<string, string> = {
  bash: "exec",
  "apply-patch": "apply_patch",
};
```

```ts
// ❌ Counter example: would cause parsePolicies alias test failures
const TOOL_NAME_ALIASES: Record<string, string> = {
  bash: "bash", // should normalize to exec
  // "apply-patch" alias missing entirely
};
```

If either alias disappears or maps to anything other than the canonical ids above, `parsePolicies` fails because it asserts the alias dictionary equals the passing snippet.

The alias map matters because policy inputs go through `normalizeToolName` before matching allow/deny lists. If `bash` stopped normalizing to `exec`, a `deny: ["bash"]` config would fail to block the canonical `exec` tool. These tests ensure the parser and SMT model stay aligned with the runtime's alias resolution.

### Owner-only fallback + subagent deny lists

```ts
// ✅ src/agents/tool-policy.ts + src/agents/pi-tools.policy.ts
const OWNER_ONLY_TOOL_NAME_FALLBACKS = new Set(["whatsapp_login", "cron", "gateway"]);

const SUBAGENT_TOOL_DENY_ALWAYS = [
  "gateway",
  "agents_list",
  "whatsapp_login",
  "session_status",
  "cron",
  "memory_search",
  "memory_get",
  "sessions_send",
];

const SUBAGENT_TOOL_DENY_LEAF = ["sessions_list", "sessions_history", "sessions_spawn"];
```

```ts
// ❌ Counter example: parsePolicies would catch these regressions
const OWNER_ONLY_TOOL_NAME_FALLBACKS = new Set(["cron"]); // missing gateway + whatsapp_login

const SUBAGENT_TOOL_DENY_ALWAYS = [
  "gateway",
  "agents_list",
  // "sessions_send" removed
];

const SUBAGENT_TOOL_DENY_LEAF = [
  // "sessions_spawn" removed
];
```

The owners-only and subagent tests assert that `gateway`, `cron`, and `whatsapp_login` stay in `OWNER_ONLY_TOOL_NAME_FALLBACKS`, that `gateway`, `session_status`, and `sessions_send` remain in `SUBAGENT_TOOL_DENY_ALWAYS`, and that `sessions_spawn` remains in `SUBAGENT_TOOL_DENY_LEAF`. The broken snippet would fail every assertion.

These tests guard two security boundaries: owner-only tools and subagent containment. If `gateway` accidentally dropped out of the owner-only fallbacks, non-owners could invoke it. If `sessions_spawn` dropped from the leaf deny list, leaf subagents could recursively spawn more agents. The tests catch accidental removals from these lists so the SMT model stays in sync with the runtime.

### Pipeline step stripping guarantees

```ts
// ✅ src/agents/tool-policy-pipeline.ts
return [
  {
    policy: params.profilePolicy,
    label: profile ? `tools.profile (${profile})` : "tools.profile",
    stripPluginOnlyAllowlist: true,
  },
  // …5 more steps omitted for brevity…
  { policy: params.groupPolicy, label: "group tools.allow", stripPluginOnlyAllowlist: true },
];
```

```ts
// ❌ Counter example: parsePipeline tests would fail
return [
  {
    policy: params.profilePolicy,
    label: profile ? `tools.profile (${profile})` : "tools.profile",
    stripPluginOnlyAllowlist: false, // should be true
  },
  { policy: params.groupPolicy, label: "group tools.allow" }, // missing flag entirely
];
```

`parsePipeline` asserts exactly seven steps and that each one sets `stripPluginOnlyAllowlist: true`. Dropping the steps or toggling the flag prevents the SMT model from proving that plugin-only allowlists are stripped before filtering core tools, so the counter example is rejected by the tests straight away.

This matters because if a step accidentally omitted `stripPluginOnlyAllowlist`, a plugin-only allowlist could block core tools — the scenario P3 ("stripping soundness") guards against. The test ensures all seven steps retain the flag so the SMT model can prove this property.
