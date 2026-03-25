# Contributing to the Channel Diagnostics Toolkit

Thank you for your interest in improving the Channel Diagnostics Toolkit!

## Philosophy

This toolkit follows these principles:

1. **Non-invasive**: Never modify existing OpenClaw code
2. **Read-only**: Only observe and report, never change state
3. **Safe**: Can be run in production without risk
4. **Helpful**: Provide actionable insights and clear guidance
5. **Maintainable**: Keep code simple and well-documented

## Adding New Diagnostic Tools

### Step 1: Identify the Need

Before adding a new tool, ask:

- Is this a common problem developers face?
- Can existing tools be extended instead?
- Will this tool provide actionable insights?

### Step 2: Design the Tool

Create a design document with:

- **Purpose**: What problem does it solve?
- **Input**: What data does it need?
- **Output**: What insights does it provide?
- **Safety**: How does it avoid side effects?

### Step 3: Implement

Follow this structure:

```typescript
#!/usr/bin/env node
/**
 * Tool Name
 *
 * Brief description of what this tool does.
 *
 * Safety: This tool is read-only and safe to run in production.
 */

import type {} from /* types */ "./types.js";

// Main logic
async function analyze(): Promise<Result> {
  // Implementation
}

// Output formatting
function printResults(results: Result): void {
  // Pretty printing
}

// CLI entry point
async function main() {
  console.log("🔍 Starting analysis...\n");

  const results = await analyze();
  printResults(results);

  // Exit with appropriate code
  process.exit(results.hasErrors ? 1 : 0);
}

main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});
```

### Step 4: Add Tests

Create tests for your tool:

```typescript
// tools/channel-diagnostics/__tests__/my-tool.test.ts
import { describe, it, expect } from "vitest";
import { analyze } from "../my-tool.js";

describe("My Tool", () => {
  it("should analyze correctly", async () => {
    const result = await analyze();
    expect(result).toBeDefined();
  });

  it("should handle errors gracefully", async () => {
    // Test error handling
  });
});
```

### Step 5: Document

Add documentation:

1. Update `README.md` with tool description
2. Add usage examples to `EXAMPLES.md`
3. Update `QUICKSTART.md` if needed
4. Add inline code comments

### Step 6: Submit PR

Follow the main [CONTRIBUTING.md](../../CONTRIBUTING.md) guidelines:

- Keep PR focused (one tool per PR)
- Include tests
- Add examples
- Update documentation

## Extending Existing Tools

### Adding New Error Patterns

Edit `error-analyzer.ts`:

```typescript
const ERROR_PATTERNS: ErrorPattern[] = [
  // ... existing patterns
  {
    pattern: "New error pattern",
    count: 0,
    channels: ["channel-name"],
    firstSeen: new Date("2026-03-24"),
    lastSeen: new Date("2026-03-24"),
    examples: ["Example error message"],
    suggestedFix: "How to fix this issue",
  },
];
```

### Adding New Health Checks

Edit `health-check.ts`:

```typescript
function checkChannelHealth(
  channelId: string,
  config: any,
  availableChannels: string[],
): HealthCheckResult {
  // ... existing checks

  // Add new check
  if (channelConfig && channelConfig.someField) {
    if (!isValid(channelConfig.someField)) {
      issues.push({
        severity: "error",
        code: "INVALID_FIELD",
        message: "Field is invalid",
        suggestion: "Fix the field value",
      });
      status = "down";
    }
  }

  return {
    /* ... */
  };
}
```

### Adding New Test Templates

Edit `test-generator.ts`:

```typescript
function generateNewTestCategory(channelId: string): TestTemplate[] {
  return [
    {
      name: "New Test Category",
      description: "Tests for new functionality",
      code: `
describe("${channelId} new tests", () => {
  it("should test new feature", async () => {
    // Test implementation
  });
});`,
    },
  ];
}
```

## Code Style

Follow OpenClaw's code style:

- Use TypeScript with strict types
- Use American English spelling
- Add JSDoc comments for public functions
- Keep functions focused and small
- Use descriptive variable names

Example:

```typescript
/**
 * Analyzes channel health and returns a diagnostic report.
 *
 * @param channelId - The channel identifier to analyze
 * @param config - The OpenClaw configuration object
 * @returns A health check result with status and issues
 */
async function analyzeChannelHealth(channelId: string, config: Config): Promise<HealthCheckResult> {
  // Implementation
}
```

## Testing Guidelines

### Unit Tests

Test individual functions:

```typescript
describe("analyzeChannelHealth", () => {
  it("should detect missing configuration", () => {
    const result = analyzeChannelHealth("telegram", {});
    expect(result.status).toBe("down");
    expect(result.issues).toHaveLength(1);
  });
});
```

### Integration Tests

Test tool end-to-end:

```typescript
describe("health-check tool", () => {
  it("should run without errors", async () => {
    const result = await runTool("health-check");
    expect(result.exitCode).toBe(0);
  });
});
```

### Manual Testing

Before submitting:

```bash
# Test all tools
node --import tsx health-check.ts
node --import tsx error-analyzer.ts
node --import tsx test-generator.ts --channel telegram
node --import tsx debug-assistant.ts

# Test with different configurations
# Test error cases
# Test edge cases
```

## Documentation Guidelines

### README Updates

When adding a tool, update the main README:

```markdown
### 5. New Tool (`new-tool.ts`)

Brief description of what it does.

\`\`\`bash
node --import tsx tools/channel-diagnostics/new-tool.ts
\`\`\`
```

### Example Updates

Add real-world examples to `EXAMPLES.md`:

```markdown
## Example N: Using New Tool

### Problem

Description of the problem.

### Solution Steps

\`\`\`bash

# Step-by-step solution

\`\`\`
```

### Quickstart Updates

If the tool is commonly used, add to `QUICKSTART.md`.

## Common Patterns

### Reading Configuration

```typescript
async function loadConfig(): Promise<any> {
  const configPath = await findConfigPath();
  if (!configPath) {
    console.warn("⚠️  No config file found");
    return { channels: {} };
  }

  try {
    const content = await readFile(configPath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    console.error(`❌ Failed to load config: ${error}`);
    return { channels: {} };
  }
}
```

### Error Handling

```typescript
try {
  const result = await riskyOperation();
  return result;
} catch (error) {
  console.error(`❌ Operation failed: ${error}`);
  // Provide helpful context
  console.log("💡 Try: openclaw doctor");
  return fallbackValue;
}
```

### User-Friendly Output

```typescript
function printResults(results: Results): void {
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║          Tool Name                     ║");
  console.log("╚════════════════════════════════════════╝\n");

  // Use emojis for visual clarity
  console.log("✅ Success");
  console.log("⚠️  Warning");
  console.log("❌ Error");
  console.log("💡 Tip");
  console.log("🔍 Info");

  // Provide actionable suggestions
  console.log("\n💡 Next steps:");
  console.log("   1. Do this");
  console.log("   2. Then this");
}
```

## Review Checklist

Before submitting your PR:

- [ ] Tool follows non-invasive principle
- [ ] Code is read-only (no state modifications)
- [ ] Error handling is comprehensive
- [ ] Output is user-friendly
- [ ] Tests are included
- [ ] Documentation is updated
- [ ] Examples are provided
- [ ] Code follows style guidelines
- [ ] Tool has been manually tested
- [ ] No dependencies on external services

## Questions?

- Check existing tools for patterns
- Read the main [CONTRIBUTING.md](../../CONTRIBUTING.md)
- Ask in [Discord](https://discord.gg/clawd)
- Open a GitHub Discussion

## Thank You!

Your contributions help make OpenClaw better for everyone. We appreciate your time and effort! 🦞
