# Recovery Guide: OpenClaw Secrets Management

This document describes recovery procedures for common failure scenarios in the secrets management subsystem.

## Table of Contents

- [Grant File Corruption](#grant-file-corruption)
- [Partial Migration](#partial-migration)
- [Keychain Failure](#keychain-failure)
- [Full Rollback](#full-rollback)
- [TOTP Seed Loss](#totp-seed-loss)
- [Audit Log Recovery](#audit-log-recovery)

---

## Grant File Corruption

### Symptoms

- Error: `Failed to parse grant file <name>.json`
- Controlled/restricted tier secrets fail to load despite recent approval
- JSON syntax errors in grant files

### Root Cause

- Filesystem corruption (power loss, disk failure)
- Partial write during grant creation
- Manual editing of grant files (unsupported)

### Recovery Steps

**Option 1: Delete and Re-Grant (Recommended)**

```bash
# 1. Identify corrupted grant file
cd ~/.openclaw/grants/
cat my-secret.json  # Check for corruption

# 2. Delete corrupted file
rm my-secret.json

# 3. Re-grant access with TOTP
openclaw secrets grant my-secret <totp-code>

# 4. Verify grant is readable
cat my-secret.json
openclaw secrets list
```

**Option 2: Manual Repair (Advanced)**

```bash
# 1. Backup corrupted file
cp my-secret.json my-secret.json.bak

# 2. Open in editor and fix JSON syntax
nano my-secret.json

# Expected structure:
# {
#   "secretName": "my-secret",
#   "grantedAt": "<ISO 8601 timestamp>",
#   "expiresAt": "<ISO 8601 timestamp>",
#   "ttlMinutes": 240
# }

# 3. Validate JSON syntax
cat my-secret.json | python3 -m json.tool

# 4. Test access
openclaw secrets get my-secret
```

### Prevention

- Use battery backup (UPS) for workstations
- Enable filesystem journaling (ext4, APFS, NTFS)
- Avoid manual editing of grant files

### Data Loss Impact

**NONE** — Grant files contain only metadata (secret names, timestamps). Secret values remain intact in OS keychain. Re-granting creates a new time-limited approval with fresh TTL.

---

## Partial Migration

### Symptoms

- Migration script interrupted mid-execution
- Some files migrated to `openclaw` user, others still owned by original user
- OpenClaw fails to start after incomplete migration

### Root Cause

- User cancelled migration script (Ctrl+C)
- Script failure due to permission errors
- System reboot during migration

### Recovery Steps

**Option 1: Resume Migration (Idempotent)**

```bash
# Migration script is safe to re-run
sudo bash scripts/migrate-to-service-account.sh

# Script checks current state before each step:
# - User creation (skips if exists)
# - Directory ownership (skips if already correct)
# - Symlink creation (skips if already exists)
# - LaunchDaemon installation (skips if already installed)
```

**Option 2: Full Rollback**

```bash
# Revert to original user-based configuration
sudo bash scripts/rollback-to-user.sh

# Then retry migration if desired
```

### Verification

```bash
# Check ownership of key directories
ls -la /opt/openclaw/.openclaw/
ls -la /opt/openclaw/projects/

# Check LaunchDaemon status
sudo launchctl list | grep ai.openclaw.gateway

# Check OpenClaw service health
openclaw gateway status
```

### Migration Script Safety Features

- **Idempotent:** Safe to run multiple times
- **State Checks:** Verifies prerequisites before each step
- **Preserves Data:** Only changes ownership, never deletes files
- **Rollback Available:** Full reversal via `rollback-to-user.sh`

---

## Keychain Failure

### Symptoms

- Error: `Failed to access OS keychain: <error>`
- `openclaw secrets get` returns "keychain unavailable"
- Secrets commands timeout or hang

### Root Causes

#### macOS

- Keychain locked (requires user authentication)
- `security` command-line tool missing or broken
- ACL permissions prevent `openclaw` process access

#### Linux

- `libsecret` not installed (`libsecret-1-0`, `libsecret-tools`)
- Keyring daemon not running (`gnome-keyring-daemon`, `kwallet`)
- D-Bus session unavailable for keyring communication

#### Windows

- Windows Credential Manager service stopped
- PowerShell execution policy prevents credential access

### Recovery Steps

**macOS:**

```bash
# 1. Verify keychain is unlocked
security unlock-keychain ~/Library/Keychains/login.keychain-db

# 2. Check for openclaw entries
security find-generic-password -l "openclaw:*" 2>&1 | head

# 3. Test keychain access
security add-generic-password -s "openclaw:test" -a "openclaw" -w "test-value"
security find-generic-password -s "openclaw:test" -w
security delete-generic-password -s "openclaw:test"

# 4. Restart OpenClaw gateway
openclaw gateway restart
```

**Linux:**

```bash
# 1. Install libsecret if missing
sudo apt-get install libsecret-1-0 libsecret-tools  # Debian/Ubuntu
sudo dnf install libsecret libsecret-devel          # Fedora/RHEL

# 2. Check keyring daemon status
ps aux | grep -E "gnome-keyring|kwallet"

# 3. Unlock default keyring
secret-tool lookup service openclaw username test || echo "Keyring locked or empty"

# 4. Test secret storage
secret-tool store --label='test' service openclaw username test
echo "test-value" | secret-tool store --label='test' service openclaw username test
secret-tool lookup service openclaw username test
secret-tool clear service openclaw username test
```

**Windows:**

```powershell
# 1. Check Credential Manager service
Get-Service -Name "VaultSvc" | Select-Object Status, StartType

# 2. List OpenClaw credentials
cmdkey /list | Select-String "openclaw"

# 3. Test credential storage
cmdkey /generic:"openclaw:test" /user:"openclaw" /pass:"test-value"
cmdkey /delete:"openclaw:test"
```

### Fallback: Re-Add Secrets

If keychain is unrecoverable, secrets must be re-added:

```bash
# 1. List secrets from configuration (metadata only)
openclaw secrets list

# 2. Re-add each secret
openclaw secrets set my-api-key --tier controlled --value "sk-..."
openclaw secrets set my-token --tier restricted --value "ghp_..."

# 3. Verify keychain storage
# macOS:
security find-generic-password -s "openclaw:my-api-key" -w

# Linux:
secret-tool lookup service openclaw name my-api-key
```

### Data Loss Impact

**POTENTIALLY HIGH** — If keychain entries are deleted or corrupted, secret values are lost. Grant files and audit logs remain intact, but secrets must be manually re-entered. **No plaintext backup exists by design.**

### Prevention

- Regular keychain backups (macOS: Time Machine, Linux: export keyring)
- Document secret sources for easy re-entry if needed
- Consider using enterprise secret manager (1Password, Vault) as primary vault backend (future feature)

---

## Full Rollback

### Use Case

- Disable secrets management subsystem entirely
- Revert to legacy credential handling (direct tool parameters)
- Troubleshooting after migration issues

### Rollback Steps

**Step 1: Stop OpenClaw Gateway**

```bash
openclaw gateway stop
```

**Step 2: Remove Configuration**

```bash
# Edit openclaw.json
nano ~/.openclaw/openclaw.json

# Remove or comment out the security.credentials section:
# {
#   "security": {
#     "credentials": {
#       "mode": "balanced",
#       "broker": { ... }
#     }
#   }
# }
```

**Step 3: (Optional) Remove Grant Files**

```bash
# Grant files are inert without configuration, but can be removed
rm -rf ~/.openclaw/grants/

# Or archive for future use
mkdir -p ~/.openclaw/archive/
mv ~/.openclaw/grants/ ~/.openclaw/archive/grants-$(date +%Y%m%d)/
```

**Step 4: Restart Gateway**

```bash
openclaw gateway start
openclaw gateway status
```

### Verification

```bash
# Confirm secrets CLI reports disabled
openclaw secrets info
# Expected: "Credential broker: disabled" or "Security mode: legacy"

# Test legacy tool execution (direct credential parameters)
openclaw --tool browser --action status
```

### What Happens to Secrets?

| Component            | After Rollback                                         |
| -------------------- | ------------------------------------------------------ |
| **Keychain Entries** | Persist but unused (safe to delete manually)           |
| **Grant Files**      | Ignored by OpenClaw (safe to delete)                   |
| **Audit Logs**       | Persist in `audit/credentials.jsonl` (safe to archive) |
| **TOTP Seed**        | Remains in authenticator app (safe to delete from app) |

**Zero Impact on Existing Functionality** — Legacy credential handling resumes immediately. No data loss, no migration required.

### Re-Enabling Secrets Management

```bash
# Restore configuration in openclaw.json
nano ~/.openclaw/openclaw.json

# Add security.credentials section (see README.md for examples)

# Restart gateway
openclaw gateway restart

# Existing keychain entries and grant files (if preserved) are reused automatically
openclaw secrets list
```

---

## TOTP Seed Loss

### Symptoms

- Authenticator app deleted or reset
- New phone without TOTP migration
- Unable to generate valid TOTP codes for grant approvals

### Recovery Steps

**Re-Generate TOTP Seed:**

```bash
# 1. Run setup command (generates new seed)
openclaw secrets setup-totp

# 2. Scan new QR code with authenticator app
# (Google Authenticator, Authy, 1Password, etc.)

# 3. Test TOTP validation
CODE=$(# Get from authenticator app)
openclaw secrets grant test-secret $CODE

# 4. Verify grant created
openclaw secrets list
```

### Data Loss Impact

**NONE** — Old TOTP codes become invalid, new codes work immediately. Existing grants created with old TOTP codes remain valid until TTL expires. Secret values in keychain are unaffected.

### Prevention

- Use authenticator app with cloud backup (Authy, 1Password)
- Save TOTP seed during initial setup (store securely, not in plaintext)
- Test TOTP regularly to ensure authenticator app is functional

---

## Audit Log Recovery

### Symptoms

- `credentials.jsonl` deleted or corrupted
- Unable to review credential access history

### Recovery Steps

**Corrupted Audit Log:**

```bash
# 1. Archive corrupted log
mv ~/.openclaw/audit/credentials.jsonl ~/.openclaw/audit/credentials.jsonl.corrupt

# 2. Create new log file (automatically created on next access)
touch ~/.openclaw/audit/credentials.jsonl

# 3. Verify new entries are logged
openclaw secrets get some-secret
tail -n 5 ~/.openclaw/audit/credentials.jsonl
```

**Deleted Audit Log:**

```bash
# No recovery possible — audit logs are append-only JSONL
# New log created automatically on next credential access
openclaw secrets get some-secret
ls -la ~/.openclaw/audit/credentials.jsonl
```

### Data Loss Impact

**LOW** — Audit logs are informational only (forensic/compliance). Loss does not affect operational capabilities. New entries are logged immediately after recovery.

### Prevention

- Regular backups of `audit/` directory
- Rotate and archive old audit logs periodically
- Consider centralized logging (syslog, CloudWatch) for audit trail preservation

---

## Emergency Procedures

### Complete System Reinstall

If OpenClaw must be completely removed and reinstalled:

```bash
# 1. Export secret names (values lost if keychain removed)
openclaw secrets list > secrets-backup.txt

# 2. Stop gateway
openclaw gateway stop

# 3. Archive OpenClaw data directory
tar -czf openclaw-backup-$(date +%Y%m%d).tar.gz ~/.openclaw/

# 4. Uninstall OpenClaw
npm uninstall -g openclaw

# 5. Remove data directory
rm -rf ~/.openclaw/

# 6. Reinstall OpenClaw
npm install -g openclaw

# 7. Restore configuration (openclaw.json)
# (Edit manually from backup)

# 8. Re-add secrets from secret-backup.txt
cat secrets-backup.txt
openclaw secrets set <name> --tier <tier> --value <value>
```

---

## Support & Escalation

For issues not covered in this guide:

1. Check [README.md](./README.md) for configuration examples
2. Review [THREAT_MODEL.md](./THREAT_MODEL.md) for security design details
3. Enable debug logging: `OPENCLAW_LOG_LEVEL=debug openclaw gateway start`
4. Open GitHub issue: https://github.com/openclaw/openclaw/issues
5. Include redacted logs and `openclaw secrets info` output

**NEVER** include secret values, TOTP codes, or grant file contents in support requests.

---

## Revision History

| Date       | Version | Changes                                              | Author             |
| ---------- | ------- | ---------------------------------------------------- | ------------------ |
| 2026-02-26 | 1.0     | Initial recovery guide for PR #27275 security review | Ratchet (Bamwerks) |
