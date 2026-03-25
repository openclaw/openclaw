# Channel Diagnostics Toolkit

A comprehensive toolkit for monitoring, diagnosing, and testing OpenClaw channel integrations.

## Purpose

This toolkit helps developers and maintainers:

- Monitor channel health and connectivity
- Diagnose common channel issues
- Generate standardized tests for channels
- Debug channel-specific problems interactively

## Tools

### 1. Health Check (`health-check.ts`)

Monitors all configured channels and reports their status.

```bash
node --import tsx tools/channel-diagnostics/health-check.ts
```

### 2. Error Analyzer (`error-analyzer.ts`)

Analyzes error patterns from logs and test failures.

```bash
node --import tsx tools/channel-diagnostics/error-analyzer.ts
```

### 3. Test Generator (`test-generator.ts`)

Generates standardized test suites for channel plugins.

```bash
node --import tsx tools/channel-diagnostics/test-generator.ts --channel telegram
```

### 4. Debug Assistant (`debug-assistant.ts`)

Interactive debugging assistant for channel issues.

```bash
node --import tsx tools/channel-diagnostics/debug-assistant.ts
```

## Design Principles

- **Non-invasive**: Does not modify existing code
- **Read-only**: Only observes and reports, never changes state
- **Safe**: Can be run in production environments
- **Helpful**: Provides actionable insights and suggestions

## Contributing

This toolkit is designed to be extended. When adding new diagnostics:

1. Keep tools focused and single-purpose
2. Provide clear output and actionable recommendations
3. Add tests for the diagnostic tools themselves
4. Update this README with usage examples
