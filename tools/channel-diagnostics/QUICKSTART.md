# Quick Start Guide

## Installation

No installation needed! The toolkit uses the existing OpenClaw dependencies.

## Usage

### 1. Health Check (Recommended First Step)

Check the health of all your channels:

```bash
cd tools/channel-diagnostics
node --import tsx health-check.ts
```

Example output:

```
🔍 Starting channel health check...

📊 Summary:
   Total Channels: 5
   ✅ Healthy: 3
   🟡 Degraded: 1
   🔴 Down: 1

✅ HEALTHY (3):
   • Telegram
   • Discord
   • Slack

🟡 DEGRADED (1):
   • WhatsApp
     ⚠️  Known issues for whatsapp
     💡 Recent fixes: Group message echo (#53624), Connection stability

🔴 DOWN (1):
   • Feishu
     ❌ Missing required field: appId
     💡 Set via: openclaw config set channels.feishu.appId YOUR_VALUE
```

### 2. Error Analysis

Analyze error patterns from changelog and logs:

```bash
node --import tsx error-analyzer.ts
```

This will show you:

- Common error patterns
- Affected channels
- Suggested fixes
- Version-specific issues

### 3. Generate Tests

Generate standardized tests for a channel:

```bash
node --import tsx test-generator.ts --channel telegram
```

This creates:

- Test suite file with common test cases
- Test plan document
- TODO markers for implementation

### 4. Interactive Debugging

Get interactive help for debugging:

```bash
node --import tsx debug-assistant.ts
```

The assistant will:

- Ask about your issue
- Provide relevant solutions
- Suggest diagnostic commands
- Point to documentation

## Common Workflows

### Workflow 1: New Channel Setup

```bash
# 1. Check if channel is available
node --import tsx health-check.ts

# 2. Configure the channel
openclaw channels add <channel>

# 3. Verify health
node --import tsx health-check.ts

# 4. Generate tests
node --import tsx test-generator.ts --channel <channel>
```

### Workflow 2: Debugging Connection Issues

```bash
# 1. Run health check
node --import tsx health-check.ts

# 2. Check for known issues
node --import tsx error-analyzer.ts

# 3. Use interactive assistant
node --import tsx debug-assistant.ts

# 4. Run OpenClaw doctor
openclaw doctor
```

### Workflow 3: Before Submitting a PR

```bash
# 1. Check channel health
node --import tsx health-check.ts

# 2. Analyze error patterns
node --import tsx error-analyzer.ts

# 3. Run tests
pnpm test:extension <channel>

# 4. Run full test suite
pnpm test
```

## Integration with OpenClaw CLI

You can also add these to your workflow:

```bash
# Add to package.json scripts (optional)
{
  "scripts": {
    "diag:health": "node --import tsx tools/channel-diagnostics/health-check.ts",
    "diag:errors": "node --import tsx tools/channel-diagnostics/error-analyzer.ts",
    "diag:debug": "node --import tsx tools/channel-diagnostics/debug-assistant.ts"
  }
}
```

Then run:

```bash
pnpm diag:health
pnpm diag:errors
pnpm diag:debug
```

## Tips

1. **Run health check regularly** - Catch issues early
2. **Check error analyzer after updates** - See if new fixes apply to you
3. **Use test generator for new channels** - Ensure consistent testing
4. **Keep toolkit updated** - Pull latest changes regularly

## Troubleshooting

### "Config file not found"

- Make sure you're in the OpenClaw project directory
- Or set up your config: `openclaw onboard`

### "Channel not found"

- Check that the channel exists in `extensions/`
- Verify the channel name is correct (lowercase)

### "Permission denied"

- Make sure you have read access to config files
- Check file permissions: `ls -la ~/.openclaw/`

## Next Steps

- Read the full [README.md](./README.md)
- Check [CONTRIBUTING.md](../../CONTRIBUTING.md) for contribution guidelines
- Join [Discord](https://discord.gg/clawd) for help
