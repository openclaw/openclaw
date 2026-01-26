# Copilot SDK enforcement

This tool enforces that the codebase only references the official `@github/copilot-sdk` package.

## What it checks

- Imports or requires of `@github/copilot*` packages outside `@github/copilot-sdk`
- `package.json` dependency entries that reference `@github/copilot*` packages other than `@github/copilot-sdk`

## Usage

Run the check from the repo root:

```
pnpm copilot:check
```

The script exits with a non-zero status if any non-SDK usage is found.
