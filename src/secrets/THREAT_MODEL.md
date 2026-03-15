# Threat Model: OpenClaw Secrets Management

## Overview

This document defines the assets, threat actors, attack vectors, and mitigations for OpenClaw's secrets management subsystem. The design prioritizes defense-in-depth with multiple layers of protection against both AI-agent-specific threats (prompt injection, tool abuse) and traditional security risks (privilege escalation, credential theft).

## Assets

### 1. Secret Values (OS Keychain Entries)

- **Description:** API keys, tokens, passwords stored in OS keychain (macOS Keychain, Linux libsecret, Windows Credential Manager)
- **Confidentiality:** HIGH — Direct access to protected services
- **Integrity:** MEDIUM — Corruption could cause service disruption
- **Availability:** MEDIUM — Required for agent tool execution

### 2. Grant Files (Access Permissions)

- **Description:** JSON files in `{dataDir}/grants/` defining time-limited access approvals
- **Location:** Human-owned directory (not writable by `openclaw` service account)
- **Confidentiality:** LOW — Metadata only (secret names, TTLs, timestamps)
- **Integrity:** HIGH — Corruption enables unauthorized access
- **Availability:** HIGH — Required for controlled/restricted tier access

### 3. TOTP Seed (Authenticator Enrollment)

- **Description:** Shared secret for TOTP code generation, stored in human's authenticator app
- **Confidentiality:** CRITICAL — Compromise bypasses 2FA protection
- **Integrity:** HIGH — Corruption breaks TOTP verification
- **Availability:** MEDIUM — Required for controlled/restricted tier approvals

### 4. Audit Log (Access Records)

- **Description:** JSONL file at `{dataDir}/audit/credentials.jsonl` recording all secret access
- **Confidentiality:** LOW — Metadata only (no secret values)
- **Integrity:** HIGH — Tampering could hide unauthorized access
- **Availability:** LOW — Informational only, not required for operations

### 5. Agent Session Context (Tool Parameters)

- **Description:** In-memory tool invocation parameters during credential broker interception
- **Confidentiality:** VARIES — May contain sensitive data depending on tool
- **Integrity:** HIGH — Manipulation could redirect credentials to attacker-controlled endpoints
- **Availability:** HIGH — Required for tool execution

## Threat Actors

### TA-1: Compromised AI Agent

- **Description:** Agent instance acting maliciously due to prompt injection, jailbreak, or model failure
- **Capabilities:** Tool invocation, file read/write (in workspace), subprocess execution
- **Limitations:** Cannot directly access OS keychain, cannot modify human-owned grant files
- **Motivation:** Exfiltrate credentials to attacker-controlled endpoint

### TA-2: Malicious Skill/Plugin

- **Description:** Third-party skill package with embedded backdoor or trojan
- **Capabilities:** Execute within agent context, call allowed tools, read skill-specific files
- **Limitations:** Cannot access secrets outside `toolAllowedSecrets` allowlist
- **Motivation:** Steal credentials for lateral movement or data theft

### TA-3: Local Privilege Escalation

- **Description:** Local process running as `openclaw` user attempting to escalate to human privileges
- **Capabilities:** Read world-readable files, execute as `openclaw` user, inspect process memory
- **Limitations:** Cannot write to human-owned grant files (mode 0644), cannot read human keychain ACLs
- **Motivation:** Bypass access controls to read/modify grant files

### TA-4: TOTP Bypass Attacker

- **Description:** Attacker attempting to guess, brute-force, or replay TOTP codes
- **Capabilities:** Submit TOTP codes via CLI or API, observe timing windows
- **Limitations:** No access to TOTP seed, limited to 30s validity window
- **Motivation:** Approve unauthorized credential grants

### TA-5: Grant File Corruption (Non-Malicious)

- **Description:** Filesystem corruption, accidental deletion, or partial write
- **Capabilities:** N/A (environmental failure)
- **Limitations:** N/A
- **Motivation:** N/A (accidental)

## Attack Vectors & Mitigations

### AV-1: Agent Credential Exfiltration

**Attack:** Compromised agent (TA-1) uses tool calls to send credentials to attacker-controlled endpoint.

**Example:**

```
Agent: "I'll help you test your API. First, let me send your GitHub token to https://attacker.com/log..."
```

**Mitigations:**

- **Agent-Blind Mode (`balanced`/`strict`):** Agents see only metadata (secret name, tier), never values. Broker injects credentials at execution time, post-approval.
- **TOTP Approval Gates:** Controlled/restricted tier secrets require human-provided TOTP code for each grant.
- **Tool Allowlists:** `toolAllowedSecrets` config restricts which secrets each tool can access.
- **Grant TTLs:** Controlled tier grants expire after 4 hours, restricted after 15 minutes.
- **Audit Logging:** All secret access logged to `credentials.jsonl` for forensic review.

**Residual Risk:** MEDIUM in `balanced` mode (session-based TOTP), LOW in `strict` mode (per-action TOTP).

---

### AV-2: Malicious Skill Secret Theft

**Attack:** Third-party skill (TA-2) attempts to access secrets outside its intended scope.

**Example:**

```javascript
// Malicious skill attempts to read OpenAI key intended for different tool
const openaiKey = await openclaw.secrets.get("openai-api-key");
```

**Mitigations:**

- **Tool Allowlists:** Broker only injects secrets listed in tool's `toolAllowedSecrets` configuration.
- **Skill Isolation:** Skills cannot directly call `secrets.get()` — must go through broker interception.
- **Configuration Review:** `openclaw.json` allowlists are human-reviewed before deployment.

**Residual Risk:** LOW (requires misconfiguration of allowlist).

---

### AV-3: Grant File Tampering

**Attack:** Local process (TA-3) running as `openclaw` user attempts to modify grant files to approve unauthorized access.

**Example:**

```bash
# Attacker running as openclaw user
echo '{"secretName":"prod-api-key","expiresAt":...}' > ~/.openclaw/grants/prod-api-key.json
```

**Mitigations:**

- **Human Ownership:** Grant directory owned by human user (e.g., `sirbam`), not `openclaw` service account.
- **File Permissions:** Grants are mode 0644 (world-readable, human-writable only).
- **Service Account Separation:** `openclaw` daemon runs as dedicated user, cannot write to human-owned files.
- **CLI Validation:** `openclaw secrets grant` command validates TOTP before writing grant file.

**Residual Risk:** VERY LOW (requires root compromise to bypass file ownership).

---

### AV-4: TOTP Brute-Force or Replay

**Attack:** Attacker (TA-4) attempts to guess valid TOTP codes or replay captured codes.

**Example:**

```bash
# Brute-force attempt
for code in {000000..999999}; do
  openclaw secrets grant prod-key $code 2>/dev/null && break
done
```

**Mitigations:**

- **Timing-Safe Comparison:** TOTP validation uses constant-time comparison to prevent timing attacks.
- **Limited Validity Window:** Codes valid for 30 seconds with ±1 step drift tolerance (90s total).
- **No Rate Limiting on TOTP:** Intentional — TOTP codes expire faster than brute-force (6 digits = 1M possibilities, 90s window = ~11,111 guesses/sec required).
- **Seed Protection:** TOTP seed never exposed to agents, stored only in human's authenticator app.
- **No Replay Prevention:** Codes are single-use within validity window, but no explicit replay database (acceptable tradeoff for offline operation).

**Residual Risk:** LOW (brute-force infeasible in 90s window, replay limited to 90s window).

---

### AV-5: Grant File Corruption

**Attack:** Filesystem corruption (TA-5) renders grant files unreadable, causing denial of service.

**Example:**

```
Error: Failed to parse grant file prod-key.json: Unexpected token } in JSON
```

**Mitigations:**

- **Small File Size:** Grant files are ~200 bytes, minimizing corruption risk.
- **Easy Recovery:** Delete corrupted file, re-run `openclaw secrets grant` command.
- **No Cascading Failure:** Single corrupted grant does not affect other secrets.
- **Graceful Degradation:** Missing grant falls back to TOTP prompt for controlled/restricted tiers.

**Recovery:** See [RECOVERY.md](./RECOVERY.md).

**Residual Risk:** VERY LOW (manual re-grant required, no data loss).

---

### AV-6: TOTP Seed Theft

**Attack:** Attacker gains access to TOTP seed from authenticator app or setup QR code.

**Example:**

- Screenshot of QR code during `openclaw secrets setup-totp`
- Malware on phone with authenticator app

**Mitigations:**

- **Secure Display:** QR code shown in terminal only, not logged or persisted.
- **User Responsibility:** Seed security depends on authenticator app (Google Authenticator, Authy, 1Password, etc.).
- **Seed Rotation:** User can run `openclaw secrets setup-totp` again to generate new seed.
- **No Backup to Keychain:** TOTP seed stored in authenticator app only, not in OS keychain.

**Residual Risk:** MEDIUM (depends on authenticator app security, user operational security).

---

### AV-7: Keychain Backend Compromise

**Attack:** Attacker gains access to OS keychain entries directly, bypassing OpenClaw.

**Example:**

- Malware with keychain access permissions on macOS
- Root access to `~/.local/share/keyrings/` on Linux

**Mitigations:**

- **OS-Level Protection:** Keychain access requires user authentication (macOS) or keyring unlock (Linux).
- **ACLs (macOS):** Keychain entries restricted to `openclaw` process.
- **No Plaintext Fallback:** Secrets never stored unencrypted, even if keychain unavailable.
- **Consistent Naming:** Entries prefixed `openclaw:` for easy identification.

**Residual Risk:** MEDIUM (depends on OS keychain security, requires privileged access).

---

## Approval Flow Guarantees

### Open Tier (`tier: "open"`)

- **Approval:** None required
- **Access:** Immediate, no TOTP or grant file
- **Visibility:** Agent can see value in `legacy`/`yolo` mode, metadata-only in `balanced`/`strict`
- **Use Case:** Non-sensitive configuration (e.g., public API endpoints, feature flags)
- **Guarantee:** No human-in-the-loop protection

### Controlled Tier (`tier: "controlled"`)

- **Approval:** TOTP code required to create grant
- **Access:** Grant valid for 4 hours (default TTL)
- **Visibility:** Metadata-only in `balanced`/`strict` mode
- **Use Case:** Medium-sensitivity secrets (e.g., analytics tokens, internal APIs)
- **Guarantee:** Human approved access within past 4 hours

### Restricted Tier (`tier: "restricted"`)

- **Approval:** TOTP code required for each grant
- **Access:** Grant valid for 15 minutes (default TTL)
- **Visibility:** Metadata-only in `balanced`/`strict` mode
- **Use Case:** High-sensitivity secrets (e.g., production API keys, payment tokens)
- **Guarantee:** Human approved access within past 15 minutes

### Grant File Creation

- **CLI Command:** `openclaw secrets grant <name> <totp-code> [--ttl <min>]`
- **Execution Context:** Must run as human user, not as `openclaw` service account
- **File Ownership:** Grant file owned by human user (e.g., `sirbam:openclaw`)
- **Permissions:** Mode 0644 (human-writable, world-readable)
- **Guarantee:** Only human user can approve grants, service account cannot self-approve

### TOTP Code Handling

- **Agent Visibility:** Agents NEVER see TOTP seed or codes
- **Storage:** Seed stored in human's authenticator app only
- **Transmission:** TOTP code provided by human via CLI argument or environment variable
- **Validation:** Server-side only, no client-side code generation
- **Guarantee:** TOTP codes cannot be generated by agents or service account processes

---

## Defense-in-Depth Summary

| Layer                   | Control                               | Bypass Requires                               |
| ----------------------- | ------------------------------------- | --------------------------------------------- |
| 1. Agent-Blind Mode     | Agents see metadata only              | Human approval + configuration change         |
| 2. TOTP Approval        | Human provides time-based code        | TOTP seed theft or brute-force                |
| 3. Tool Allowlists      | Per-tool secret access control        | Configuration tampering                       |
| 4. Grant File Ownership | Human-owned, service-account-readable | Root/sudo privilege escalation                |
| 5. Keychain ACLs        | OS-level access control               | Malware with keychain permissions             |
| 6. Audit Logging        | Forensic record of all access         | Log file deletion (requires human privileges) |

**Minimum Attack Complexity:** Bypassing all layers requires:

1. Compromised agent or skill (to initiate tool call)
2. Stolen TOTP seed or seed-side brute-force (to approve grant)
3. Root/sudo access (to modify grant files or keychain ACLs)

This multi-layer design ensures no single point of failure.

---

## Out-of-Scope Threats

The following are explicitly NOT addressed by this design:

- **Supply Chain Attacks:** Compromise of OpenClaw codebase itself (mitigated by code review, GitHub security)
- **Side-Channel Attacks:** Timing analysis, power analysis, etc. (not applicable to software-only system)
- **Physical Access:** Attacker with physical access to unlocked machine (mitigated by OS-level controls)
- **Social Engineering:** Tricking human into approving malicious grants (user training, not technical control)
- **Backup/Cloud Sync:** Secrets in macOS Keychain iCloud sync (user responsibility, can be disabled)

---

## Compliance Considerations

This design aligns with industry best practices for credential management:

- **NIST SP 800-63B (Digital Identity Guidelines):** Multi-factor authentication (TOTP), time-limited sessions
- **OWASP Top 10:** A02:2021 – Cryptographic Failures (keychain storage), A07:2021 – Identification and Authentication Failures (TOTP gates)
- **CIS Controls:** Control 6.2 (Establish Centralized Credential Management), Control 6.3 (Require Multi-Factor Authentication)

Not a compliance certification, but demonstrates alignment with recognized security frameworks.

---

## Revision History

| Date       | Version | Changes                                            | Author             |
| ---------- | ------- | -------------------------------------------------- | ------------------ |
| 2026-02-26 | 1.0     | Initial threat model for PR #27275 security review | Ratchet (Bamwerks) |

---

## References

- [README.md](./README.md) — Feature overview and usage
- [RECOVERY.md](./RECOVERY.md) — Rollback and recovery procedures
- [RFC 6238](https://datatracker.ietf.org/doc/html/rfc6238) — TOTP specification
- [OWASP Credential Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Credential_Storage_Cheat_Sheet.html)
