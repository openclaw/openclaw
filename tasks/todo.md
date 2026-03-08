# Signal quote reply fix

- [x] Inspect current reply consumption and Signal quote validation flow
- [x] Implement fix so invalid explicit Signal reply ids do not consume inherited reply state
- [x] Add or update regression tests for outbound delivery and Signal send behavior
- [x] Run targeted verification for touched test files and broader related tests if quick
- [x] Review diff, update this file with results, and commit/push changes

## Notes

- Status: pushed
- Shared Signal quote metadata validation now drives:
  - Signal send param construction
  - outbound reply consumption
  - monitor reply consumption
- Regression coverage added for:
  - malformed explicit Signal `replyToId` preserving inherited reply state
  - group replies without `quoteAuthor` preserving inherited reply state
  - direct-message valid numeric replies still emitting `quote-timestamp`
  - existing partial-chunk failure case using a valid Signal timestamp fixture
- Verification:
  - `pnpm exec vitest run --config vitest.unit.config.ts src/infra/outbound/deliver.test.ts src/signal/send.test.ts src/signal/monitor/reply-delivery.test.ts src/signal/monitor/event-handler.quote.test.ts`
  - `pnpm exec vitest run --config vitest.unit.config.ts src/signal/*.test.ts src/signal/monitor/*.test.ts`
  - `pnpm exec oxfmt --check src/infra/outbound/deliver.ts src/infra/outbound/deliver.test.ts src/signal/send.ts src/signal/send.test.ts src/signal/monitor.ts src/signal/monitor/reply-delivery.ts src/signal/monitor/reply-delivery.test.ts src/signal/reply-quote.ts tasks/todo.md`
- Commit:
  - `a1e5c2966` `Signal: preserve inherited quote state`
- Push:
  - `git push origin fix/signal-quote-reply`
