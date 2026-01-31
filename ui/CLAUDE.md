# OpenClaw Control Center UI

## Project Overview
This is a web-based configuration UI for OpenClaw, an AI agent orchestration platform. The UI provides visual management of model providers, agent settings, channels, permissions, and gateway configuration.

## Location
- Main project: `~/Programming/moltbot/ui/`
- Translated UI source: `src/ui-zh-CN/`
- i18n files: `src/ui-zh-CN/i18n/` (en.ts, es.ts, zh-CN.ts)

## Tech Stack
- **Framework:** Lit (Web Components)
- **Language:** TypeScript
- **Build:** Vite
- **Connection:** WebSocket to OpenClaw gateway

## Current State (Jan 2026)
- ✅ Translation from Chinese to English: Complete
- ✅ i18n system with 3 languages (en, es, zh-CN)
- ✅ Build passing (vite 7.3.1, 666KB JS bundle)
- ✅ Gateway connection working
- ✅ All 131 tests passing
- ⚠️ Spanish translations: 28% complete (193/688 keys)
- ⚠️ Chinese translations: 78% complete (536/688 keys)

## Development Commands
```bash
npm run dev      # Start dev server at localhost:5173
npm run build    # Production build to ../dist/control-ui
npm run lint     # Run linter
```

## Testing with Gateway
Connect to local gateway:
```
http://localhost:5173/?gatewayUrl=ws://localhost:18789&token=<gateway-token>
```

## Project Structure
```
src/ui-zh-CN/
├── i18n/           # Translation files
│   ├── en.ts       # English (default)
│   ├── es.ts       # Spanish
│   ├── zh-CN.ts    # Chinese
│   └── index.ts    # i18n module
├── components/     # UI components
├── controllers/    # State controllers
├── views/          # Page views
└── types/          # TypeScript types
```

## Known Issues / TODOs
1. ~~Duplicate keys in i18n files~~ - **FIXED** (no duplicates found)
2. Spanish translations incomplete (495 missing keys out of 688)
3. Chinese translations missing 153 keys (mostly channel-related)
4. Some UI sections may need polish/testing
5. Error handling could be improved
6. Bundle size warning (666KB JS) - consider code splitting

## Key Files
- `src/ui/navigation.ts` - Tab labels and navigation
- `src/ui/gateway.ts` - WebSocket connection to gateway
- `src/ui-zh-CN/views/model-config.ts` - Main config view

## Git Workflow

### Repository Setup
```
origin    → https://github.com/moltbot/moltbot.git       (upstream - official)
fork      → https://github.com/octopuslabs-fl/openclaw   (our fork)
```

### Current Branch
- `feature/ui-config-i18n` — English i18n translation work

### Syncing with Upstream
```bash
# Fetch latest from official repo
git fetch origin

# Update local main branch
git checkout main
git merge origin/main

# Rebase feature branch on latest main
git checkout feature/ui-config-i18n
git rebase main

# Push to fork (force needed after rebase)
git push fork feature/ui-config-i18n --force-with-lease
```

**Or use gh CLI:**
```bash
# Sync fork's main with upstream
~/bin/gh repo sync octopuslabs-fl/openclaw --branch main
```

### Before Creating PR to Upstream

**Checklist:**
- [ ] All tests passing (`npm test`)
- [ ] Build clean (`npm run build`)
- [ ] Tested against live gateway
- [ ] English translations complete (688/688)
- [ ] No console errors in browser
- [ ] Code reviewed / self-reviewed

**Create PR:**
```bash
# Ensure branch is up to date with upstream main
git fetch origin
git rebase origin/main

# Push final changes
git push fork feature/ui-config-i18n --force-with-lease

# Create PR via CLI
~/bin/gh pr create \
  --repo moltbot/moltbot \
  --head octopuslabs-fl:feature/ui-config-i18n \
  --base main \
  --title "feat(ui): Complete English i18n translation" \
  --body "## Summary
- Translate all 688 i18n keys from Chinese to English
- Add complete i18n system with language switcher
- All 131 tests passing

## Changes
- Complete English translations (688 keys)
- Partial Spanish (193/688) and Chinese (536/688) translations
- Updated components to use i18n system"
```

**Or create via web:**
https://github.com/moltbot/moltbot/compare/main...octopuslabs-fl:feature/ui-config-i18n

## Contributing Guidelines
- Use `t('key')` for all user-facing strings
- Add new keys to all 3 language files
- Test with `npm run build` before committing
- Run dev server to verify changes visually
