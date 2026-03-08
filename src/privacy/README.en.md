# Privacy Filter Module

The OpenClaw Privacy Filter module automatically detects and replaces sensitive information in messages before they are sent to LLM APIs, then restores the original content in LLM responses — ensuring private data never leaks to external services.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Core Pipeline](#core-pipeline)
- [Module Reference](#module-reference)
- [Built-in Rules](#built-in-rules)
- [Configuration](#configuration)
- [Custom Rules](#custom-rules)
- [Replacement Templates](#replacement-templates)
- [Named Validators](#named-validators)
- [API Reference](#api-reference)

---

## Architecture Overview

```
User Input (with sensitive data)
     │
     ▼
 ┌──────────┐     ┌──────────┐     ┌──────────┐
 │ Detector │────▶│ Replacer │────▶│  Store   │
 │  Engine  │     │  Engine  │     │ Encrypted│
 └──────────┘     └──────────┘     └──────────┘
     │                 │
     │   ┌─────────────┘
     ▼   ▼
 ┌──────────────┐
 │StreamWrapper │  ← Wraps LLM call stream
 │ Outbound:    │
 │   Replace    │
 │ Inbound:     │
 │   Restore    │
 └──────────────┘
     │
     ▼
  LLM API (sees only replaced content)
```

## Core Pipeline

1. **Detect** — `PrivacyDetector` scans text using regex patterns, keyword matching, and context constraints to identify sensitive information
2. **Replace** — `PrivacyReplacer` substitutes sensitive content with format-compatible fake values (e.g. `user@gmail.com` → `pf_e1234567890@example.net`), preserving semantic structure so the LLM can still understand context
3. **Persist** — `PrivacyMappingStore` encrypts and saves the original-to-replacement mappings using AES-256-GCM
4. **Restore** — Replacement values in LLM responses are automatically restored to the original content, so users see real information

## Module Reference

| File                | Responsibility                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`          | All type definitions: `PrivacyRule`, `DetectionMatch`, `PrivacyConfig`, `UserDefinedRule`, `CustomRulesConfig`, etc.                   |
| `rules.ts`          | Built-in rule sets (`BASIC_RULES` and `EXTENDED_RULES`) and the `resolveRules()` entry point                                           |
| `detector.ts`       | Detection engine `PrivacyDetector`: compiles rules, regex matching, context validation, password complexity and entropy checks         |
| `replacer.ts`       | Replacement engine `PrivacyReplacer`: generates type-specific fake values, maintains bidirectional mappings, supports custom templates |
| `mapping-store.ts`  | Encrypted persistent store `PrivacyMappingStore`: AES-256-GCM encryption, PBKDF2 key derivation, session-scoped isolation              |
| `stream-wrapper.ts` | LLM stream wrapper: intercepts outbound messages for replacement, intercepts inbound responses for restoration                         |
| `custom-rules.ts`   | Custom rules module: loads user-defined rules from JSON/JSON5 files, validates, and merges with built-in rules                         |
| `index.ts`          | Unified public API exports                                                                                                             |

## Built-in Rules

### Basic Rule Set

High-priority, low-false-positive core rules:

| Type                        | Risk Level | Description                                              |
| --------------------------- | ---------- | -------------------------------------------------------- |
| `email`                     | medium     | Email addresses                                          |
| `phone_cn`                  | medium     | China mainland phone numbers                             |
| `id_card_cn`                | high       | China national ID card numbers                           |
| `credit_card`               | critical   | Credit card numbers (Visa/MasterCard/Amex/Discover)      |
| `bank_account_cn`           | critical   | China bank account numbers (requires context keywords)   |
| `password_assignment`       | critical   | Password assignment statements (`password=xxx`)          |
| `env_password`              | critical   | Environment variable passwords (`PASSWORD=xxx`)          |
| `github_token`              | critical   | GitHub access tokens                                     |
| `openai_api_key`            | critical   | OpenAI API keys                                          |
| `slack_token`               | critical   | Slack tokens                                             |
| `google_api_key`            | critical   | Google API keys                                          |
| `stripe_api_key`            | critical   | Stripe API keys                                          |
| `aws_access_key`            | critical   | AWS access key IDs                                       |
| `aws_secret_key`            | critical   | AWS secret access keys                                   |
| `alibaba_access_key`        | critical   | Alibaba Cloud AccessKeys                                 |
| `tencent_secret_id`         | critical   | Tencent Cloud SecretIds                                  |
| `jwt_token`                 | high       | JWT tokens                                               |
| `generic_api_key`           | high       | Generic API key patterns                                 |
| `bearer_token`              | high       | Bearer tokens                                            |
| `ssh_private_key`           | critical   | SSH private keys                                         |
| `database_url_*`            | critical   | MySQL/PostgreSQL/MongoDB connection strings              |
| `redis_url`                 | critical   | Redis connection strings                                 |
| `url_with_credentials`      | critical   | URLs with embedded credentials                           |
| `basic_auth`                | critical   | HTTP Basic authentication                                |
| `social_security_number_us` | critical   | US Social Security Numbers                               |
| `bare_password`             | high       | Bare passwords (3+ character class complexity detection) |
| `high_entropy_string`       | high       | High-entropy strings (likely keys/tokens)                |

### Extended Rule Set (Default)

Includes all Basic rules, plus:

- Additional phone formats: Hong Kong, Taiwan, US
- Additional IDs: Hong Kong ID card, China passport, multi-country passports
- UnionPay cards, IBAN
- Alipay accounts, WeChat IDs
- Additional API keys: Anthropic, GitLab, Discord, NPM, PyPI, SendGrid, Twilio, Shopify, Square, New Relic, Mailchimp, Sentry
- Azure Storage keys, Azure Client Secrets
- JDBC, .NET connection strings, Elasticsearch, RabbitMQ
- OAuth tokens, Session tokens
- Cryptocurrency private keys, Ethereum addresses
- Salary amounts

---

## Configuration

Set the `privacy` field in your OpenClaw configuration file:

```json5
{
  privacy: {
    // Enable/disable privacy filtering (default: true)
    enabled: true,

    // Rule set: "basic" | "extended" | path to custom rules file
    rules: "extended",

    // Encryption settings
    encryption: {
      algorithm: "aes-256-gcm",
      salt: "", // Leave empty to auto-generate
    },

    // Mapping store settings
    mappings: {
      ttl: 86400000, // Mapping expiration time, default 24 hours (ms)
      storePath: "", // Leave empty for default: ~/.openclaw/privacy/mappings.enc
    },

    // Logging settings
    log: {
      useReplacedContent: true, // Use replaced content in logs
    },
  },
}
```

---

## Custom Rules

When built-in rules don't meet your needs, you can define custom detection rules via a JSON/JSON5 file.

### Enabling Custom Rules

Set `privacy.rules` to the path of your custom rules file:

```json
{
  "privacy": {
    "enabled": true,
    "rules": "./my-privacy-rules.json5"
  }
}
```

### Config File Format

```json5
{
  // Base preset: "basic" | "extended" | "none"
  // Custom rules are layered on top of the base preset
  // Default: "extended"
  extends: "extended",

  // Built-in rule types to disable
  // These rules remain in the list but have enabled set to false
  disable: ["bare_password", "high_entropy_string"],

  // Custom rule definitions
  rules: [
    // ... rule definitions
  ],
}
```

### Rule Definition Fields

```json5
{
  // [Required] Rule type identifier, must be snake_case (e.g. "employee_id")
  type: "employee_id",

  // [Required] Human-readable description
  description: "Internal employee ID (EMP-XXXXXX)",

  // [Required] Risk level: "low" | "medium" | "high" | "critical"
  riskLevel: "medium",

  // [Optional] Regex pattern (at least one of pattern or keywords is required)
  // Supports (?i) prefix for case-insensitive matching
  pattern: "\\bEMP-[0-9]{6}\\b",

  // [Optional] Keyword list (at least one of pattern or keywords is required)
  keywords: ["Project-Phoenix", "Project-Titan"],

  // [Optional] Whether keyword matching is case-sensitive, default: false
  caseSensitive: true,

  // [Optional] Context constraints to reduce false positives
  context: {
    mustContain: ["server", "host"], // At least one keyword must appear near the match
    mustNotContain: ["example", "test"], // None of these keywords may appear near the match
  },

  // [Optional] Whether this rule is enabled, default: true
  enabled: true,

  // [Optional] Named validator function for post-match validation
  // Available: "bare_password" | "high_entropy"
  validateFn: "bare_password",

  // [Optional] Custom replacement template (see "Replacement Templates" section)
  replacementTemplate: "EMP-REDACTED-{seq}",
}
```

### Full Example

```json5
{
  extends: "basic",

  disable: [
    "bare_password", // Disable bare password detection (high false-positive rate)
    "high_entropy_string", // Disable high-entropy string detection
  ],

  rules: [
    // 1. New rule: company employee ID
    {
      type: "employee_id",
      description: "Internal employee ID (EMP-XXXXXX)",
      riskLevel: "medium",
      pattern: "\\bEMP-[0-9]{6}\\b",
      replacementTemplate: "EMP-000{seq}00",
    },

    // 2. New rule: Japanese phone number
    {
      type: "phone_jp",
      description: "Japan mobile phone number",
      riskLevel: "medium",
      pattern: "\\b0[789]0-?\\d{4}-?\\d{4}\\b",
    },

    // 3. Override built-in: lower email risk level
    {
      type: "email",
      description: "Email address (low risk)",
      riskLevel: "low",
      pattern: "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b",
    },

    // 4. Keyword detection: internal project codenames
    {
      type: "internal_codename",
      description: "Internal project codename",
      riskLevel: "high",
      keywords: ["Project-Phoenix", "Project-Titan", "Project-Nova"],
      caseSensitive: true,
    },

    // 5. Context-constrained: only detect IPs in specific contexts
    {
      type: "server_ip",
      description: "Server IP address",
      riskLevel: "medium",
      pattern: "\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b",
      context: {
        mustContain: ["server", "host", "node"],
        mustNotContain: ["example", "localhost"],
      },
    },
  ],
}
```

### Merge Behavior

- **Same-type override**: Custom rules with the same `type` as a built-in rule **entirely replace** the built-in rule (no partial merge)
- **New types appended**: Rule types not present in the base preset are appended to the end of the rule list
- **Disable list**: Disabled rules remain in the list with `enabled` set to `false`

### Validation

Custom rules are validated at load time:

| Check             | Description                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `type` format     | Must match `[a-z][a-z0-9_]*` (lowercase snake_case)                                        |
| Required fields   | `type`, `description`, `riskLevel` must not be empty                                       |
| `riskLevel` value | Must be one of `low` / `medium` / `high` / `critical`                                      |
| Match method      | At least one of `pattern` or `keywords` must be provided                                   |
| Regex safety      | Pattern must compile, not exceed 2000 characters, no nested quantifiers (ReDoS prevention) |
| `validateFn`      | If provided, must be a registered named validator                                          |

Rules that fail validation are skipped (they don't cause the entire load to fail). Errors are reported via `console.warn`.

---

## Replacement Templates

Custom rules can define a `replacementTemplate` field to control the format of replacement values.

### Supported Placeholders

| Placeholder           | Description                                  | Example                                           |
| --------------------- | -------------------------------------------- | ------------------------------------------------- |
| `{type}`              | Rule type identifier                         | `employee_id`                                     |
| `{seq}`               | Session-scoped sequence number (starts at 0) | `0`, `1`, `2`                                     |
| `{ts}`                | Last 10 digits of the timestamp              | `1234567890`                                      |
| `{original_prefix:N}` | First N characters of the original content   | For `EMP-123456` → `{original_prefix:4}` = `EMP-` |
| `{original_length}`   | Length of the original content               | `10`                                              |
| `{pad:N}`             | N `x` characters for padding                 | `{pad:5}` = `xxxxx`                               |

### Template Examples

```json5
// Employee ID: preserve prefix, pad with sequence
"replacementTemplate": "EMP-{seq}00000"
// EMP-123456 → EMP-000000

// Preserve original prefix
"replacementTemplate": "{original_prefix:4}XXXX-0000"
// INT-ABCD-1234 → INT-XXXX-0000

// Generic redaction with type tag
"replacementTemplate": "REDACTED_{type}_{seq}"
// Any match → REDACTED_employee_id_0

// Fixed-length padding
"replacementTemplate": "***{pad:10}***"
// Any match → ***xxxxxxxxxx***
```

If no `replacementTemplate` is provided, the system uses built-in type-specific replacement logic (e.g. emails generate fake emails, phone numbers generate fake phone numbers), or the generic format `pf_{type}_{timestamp}{seq}` for unknown types.

---

## Named Validators

Since JSON config files cannot contain functions, custom rules reference pre-registered named validators via the `validateFn` field.

### Built-in Validators

| Name            | Description                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `bare_password` | Checks if a string has password characteristics (3+ character classes, 8-64 chars, excludes URLs/paths and other common false positives) |
| `high_entropy`  | Checks if a string is a high-entropy random string (Shannon entropy >= 3.5 bits/char, >= 16 chars, excludes sequential characters)       |

### Registering Custom Validators

Plugins or extensions can register new validators via the API:

```typescript
import { registerNamedValidator } from "./privacy/index.js";

// Register a custom validator
registerNamedValidator("luhn_check", (s: string) => {
  // Luhn algorithm check (credit card numbers)
  let sum = 0;
  let alternate = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let n = parseInt(s[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
});
```

Then reference it in a custom rule:

```json5
{
  type: "custom_card",
  description: "Custom card number detection",
  riskLevel: "critical",
  pattern: "\\b\\d{16}\\b",
  validateFn: "luhn_check",
}
```

---

## API Reference

### Core Classes

#### `PrivacyDetector`

```typescript
// Using a preset
const detector = new PrivacyDetector("extended");

// Using a custom rules array
const detector = new PrivacyDetector(customRules);

// Detect
const result: FilterResult = detector.detect("text with sensitive@email.com");
// result.hasPrivacyRisk → true
// result.matches → [{ type: "email", content: "sensitive@email.com", ... }]

// Quick check
const hasSensitive: boolean = detector.check("some text");
```

#### `PrivacyReplacer`

```typescript
const replacer = new PrivacyReplacer("session-id");

// Replace detected sensitive content
const { replaced, newMappings } = replacer.replaceAll(text, matches);

// Restore replaced content
const original = replacer.restore(replacedText);
```

#### `PrivacyMappingStore`

```typescript
const store = new PrivacyMappingStore({ salt: "my-salt" });

store.save(mappings); // Encrypt and save
const loaded = store.load(); // Load all
const session = store.loadSession(id); // Load by session
store.append(newMappings); // Append new mappings
store.cleanup(86_400_000); // Remove expired mappings
store.clearSession(sessionId); // Clear a specific session
```

### Custom Rules Functions

```typescript
import {
  loadCustomRules,
  processCustomRulesConfig,
  validateUserRule,
  validateRegexSafety,
  registerNamedValidator,
  getNamedValidators,
} from "./privacy/index.js";

// Load from file
const result = loadCustomRules("./my-rules.json5");
// result.rules    → merged rules array
// result.errors   → validation errors
// result.warnings → warning messages

// Process from object
const result = processCustomRulesConfig({
  extends: "basic",
  disable: ["email"],
  rules: [{ type: "custom", description: "...", riskLevel: "low", pattern: "..." }],
});

// Validate a single rule
const errors = validateUserRule(rule, 0);

// Validate regex safety
const error = validateRegexSafety("(a+)+"); // → "contains nested quantifiers..."

// List registered validators
const names = getNamedValidators(); // → ["bare_password", "high_entropy"]
```

### Stream Wrapper (Integration)

```typescript
import {
  createPrivacyFilterContext,
  filterText,
  restoreText,
  filterPrompt,
  restoreResponse,
  wrapStreamFnPrivacyFilter,
} from "./privacy/index.js";

// Create a session-scoped context
const ctx = createPrivacyFilterContext("session-123", { rules: "./my-rules.json5" });

// Filter a text string
const filtered = filterText("my password=Secret123!", ctx);

// Restore
const restored = restoreText(filtered, ctx);

// Wrap LLM stream function
const wrappedStreamFn = wrapStreamFnPrivacyFilter(originalStreamFn, ctx);
```
