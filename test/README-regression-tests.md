# Webchat Control UI Regression Tests

This directory contains regression tests for the webchat Control UI to prevent recurring issues.

## Test Files

### E2E Tests (Controller Level)

- **`test/chat-regression.e2e.test.ts`** - Tests the chat controller functions for:
  - Message resending (idempotency, single send)
  - Image upload URL handling (no private IP, no doubled paths)
  - iOS typing lag (controlled input handling)
  - Stop/abort command handling
  - Connection state handling
  - NO_REPLY suppression

### Browser Tests (UI Level)

- **`ui/src/ui/views/chat-input.browser.test.ts`** - Tests the chat input component for:
  - Controlled input value handling
  - Enter/Shift+Enter behavior
  - IME composition handling
  - Connection state UI
  - Placeholder states

## Running Tests

### E2E Tests

```bash
# Run all e2e tests
pnpm test:e2e

# Run only chat regression tests
pnpm vitest run --config vitest.e2e.config.ts test/chat-regression.e2e.test.ts
```

### Browser Tests

```bash
# Run from the ui/ directory
cd ui && pnpm test src/ui/views/chat-input.browser.test.ts

# Or from repo root
pnpm vitest run --config ui/vitest.config.ts ui/src/ui/views/chat-input.browser.test.ts
```

### Run All Tests

```bash
# Run main test suite (includes browser tests)
pnpm test

# Run e2e tests
pnpm test:e2e
```

## CI Integration

These tests are automatically run in CI via `.github/workflows/ci.yml`:

1. **E2E Tests**: Run via `pnpm test:e2e` which uses `vitest.e2e.config.ts`
2. **Browser Tests**: Run via `pnpm test` which uses the main `vitest.config.ts`

## Regressions Covered

### 1. Message Resending

- **Issue**: Messages getting sent more than once
- **Fix Location**: `ui/src/ui/controllers/chat.ts` (idempotency keys)
- **Tests**:
  - `sends message exactly once (no duplicate sends)`
  - `uses idempotency key to prevent duplicates`
  - `queues subsequent messages while busy`

### 2. Image Upload URL Handling

- **Issue**: Private IP exposed in URLs, doubled URL paths
- **Fix Location**: `ui/src/ui/controllers/chat.ts` (attachment processing)
- **Tests**:
  - `converts data URL to base64 content without private IP paths`
  - `does not double URL paths in attachment source`
  - `handles multiple image attachments correctly`

### 3. iOS Typing Lag

- **Issue**: useEffect causing controlled input lag
- **Fix Location**: `ui/src/ui/views/chat.ts` (input handling)
- **Tests**:
  - `does not trigger excessive re-renders during typing`
  - `handles empty message gracefully (no send)`
  - `allows sending with only attachments (no text)`

## Adding New Regression Tests

When adding new regression tests:

1. **E2E Tests**: Add to `test/chat-regression.e2e.test.ts`
   - Use `createMockGatewayClient()` for mocked gateway
   - Use `createTestChatState()` for chat state
   - Use `createTestChatHost()` for host state

2. **Browser Tests**: Add to `ui/src/ui/views/chat-input.browser.test.ts`
   - Use `createProps()` for chat props
   - Use `render(renderChat(...), container)` to render

3. **Document the regression**: Add a section to this README

## Setup Files

- **`test/e2e-setup.ts`** - Mocks browser globals (localStorage, navigator) for Node.js
- **`test/setup.ts`** - Main test setup (plugin registry, etc.)
