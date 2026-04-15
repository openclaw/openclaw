# Task Plan - whatsapp-baileys-fix

## Goal
Make `build-smoke` and `extension-fast (extension-fast-whatsapp, whatsapp)` pass on PR 66976 by removing remaining root-dist `@whiskeysockets/baileys` leakage and fixing current WhatsApp login test regressions.

## Success Criteria
- `build-smoke` no longer reports root dist imports of `@whiskeysockets/baileys`
- `extension-fast (extension-fast-whatsapp, whatsapp)` passes
- No new preflight/submodule regressions

## Stages
1. Inspect current upstream PR head and local branch divergence
2. Pull exact failing-source chain for `monitor-*.js` and `session-*.js`
3. Fix local test regressions in `login.ts` / tests if still relevant
4. Verify with targeted tests/build checks
5. Commit only if local changes are actually needed

## Risks
- Upstream commits may have superseded local work
- More static imports may still exist through runtime wrappers
- Test seam may be broken by signature drift

## Verification
- inspect current PR head commits
- run targeted vitest for whatsapp login tests
- run targeted build-smoke/root-dist check if available
