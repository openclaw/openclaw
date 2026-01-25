# Task 7: Redesign Logs View with Terminal Aesthetic

## Overview
Redesign the logs view (`ui/src/ui/views/logs.ts`) with a modern terminal aesthetic, syntax highlighting for log levels, and improved log browsing UX.

## Project Context

### Tech Stack
- **Framework**: Lit (Web Components) - NOT React
- **Styling**: Tailwind CSS v4 with CSS-first configuration
- **Build**: Vite
- **Icons**: Custom SVG icon system in `ui/src/ui/icons.ts`

### Key Files
- View to modify: `ui/src/ui/views/logs.ts`
- Styles: `ui/src/styles/components.css` (append new styles)
- Icons: `ui/src/ui/icons.ts` (import and use `icon()` function)
- Design tokens: `ui/src/styles/base.css` (CSS variables)

## Design System Reference

### CSS Variables (from base.css)
```css
/* Dark theme */
--bg: #0a0f14;
--panel: rgba(14, 20, 30, 0.88);
--text: rgba(244, 246, 251, 0.96);
--muted: rgba(156, 169, 189, 0.72);
--border: rgba(255, 255, 255, 0.09);
--accent: #f59f4a;
--ok: #2bd97f;
--warn: #f2c94c;
--danger: #ff6b6b;
--mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
```

### Icon System Usage
```typescript
import { icon } from "../icons";

// In template:
${icon("scroll-text", { size: 20 })}
${icon("filter", { size: 16 })}
${icon("search", { size: 16 })}
```

Available icons: `message-square`, `layout-dashboard`, `link`, `radio`, `file-text`, `clock`, `zap`, `server`, `settings`, `bug`, `scroll-text`, `book-open`, `chevron-down`, `chevron-right`, `chevron-left`, `menu`, `x`, `sun`, `moon`, `monitor`, `refresh-cw`, `maximize`, `brain`, `sparkles`, `user`, `log-out`, `check`, `alert-circle`, `info`, `alert-triangle`, `plus`, `minus`, `search`, `filter`, `more-vertical`, `edit`, `trash`, `copy`, `external-link`, `play`, `pause`, `stop`, `send`, `panel-left`

## Design Requirements

### Visual Style - Terminal Aesthetic
1. **Dark background** - Near-black with subtle texture
2. **Monospace font** - IBM Plex Mono for all log content
3. **Syntax highlighting** - Color-coded log levels
4. **Line numbers** - Optional line number gutter
5. **Scrolling** - Smooth scroll with auto-follow option
6. **Selection** - Easy text selection for copying

### Log Level Colors
```css
--log-debug: #6b7280;   /* gray */
--log-info: #3b82f6;    /* blue */
--log-warn: #f59e0b;    /* amber */
--log-error: #ef4444;   /* red */
--log-fatal: #dc2626;   /* dark red */
--log-trace: #8b5cf6;   /* purple */
```

### Logs View Specific Requirements
1. **Log toolbar** - Filter, search, auto-follow toggle, export
2. **Level filters** - Toggle buttons for each log level
3. **Text search** - Highlight matches in logs
4. **Timestamp display** - Relative or absolute toggle
5. **Auto-follow** - Stick to bottom as new logs arrive
6. **Export** - Download filtered logs as file
7. **Clear** - Clear current view (not source)
8. **Truncation indicator** - Show if logs were truncated

### Suggested Layout
```
┌─────────────────────────────────────────────────┐
│ Logs Header (title, file path)                  │
├─────────────────────────────────────────────────┤
│ Toolbar                                         │
│ [Search...] [DEBUG] [INFO] [WARN] [ERROR]      │
│ [Auto-follow ●] [Export] [Clear] [Refresh]     │
├─────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────┐ │
│ │ 001 │ 12:34:56 │ INFO  │ Server started    │ │
│ │ 002 │ 12:34:57 │ DEBUG │ Loading config    │ │
│ │ 003 │ 12:34:58 │ WARN  │ Deprecated API    │ │
│ │ 004 │ 12:34:59 │ ERROR │ Connection failed │ │
│ │ ... │          │       │                   │ │
│ └─────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────┤
│ Status: 1,234 entries │ Filtered: 456 │ Live   │
└─────────────────────────────────────────────────┘
```

## CSS Classes to Add (append to components.css)

```css
/* Logs View - Terminal Aesthetic */
.logs-container { /* main container */ }
.logs-toolbar { /* toolbar container */ }
.logs-toolbar__search { /* search input */ }
.logs-toolbar__levels { /* level filter buttons */ }
.logs-toolbar__actions { /* action buttons */ }

.logs-level-btn { /* level toggle button */ }
.logs-level-btn--active { /* active state */ }
.logs-level-btn--debug { /* debug level */ }
.logs-level-btn--info { /* info level */ }
.logs-level-btn--warn { /* warn level */ }
.logs-level-btn--error { /* error level */ }

.logs-terminal { /* terminal-style log viewer */ }
.logs-terminal__gutter { /* line number column */ }
.logs-terminal__content { /* log content area */ }

.log-entry { /* single log line */ }
.log-entry--debug { /* debug styling */ }
.log-entry--info { /* info styling */ }
.log-entry--warn { /* warn styling */ }
.log-entry--error { /* error styling */ }
.log-entry--highlight { /* search match highlight */ }

.log-entry__line { /* line number */ }
.log-entry__time { /* timestamp */ }
.log-entry__level { /* level badge */ }
.log-entry__message { /* log message */ }

.logs-status { /* status bar */ }
.logs-status__count { /* entry count */ }
.logs-status__live { /* live indicator */ }

.logs-empty { /* empty state */ }
.logs-truncated { /* truncation warning */ }
```

### Terminal Styling
```css
.logs-terminal {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
  background: linear-gradient(180deg, #0d1117 0%, #010409 100%);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  overflow: hidden;
}

.logs-terminal__content {
  padding: 16px;
  overflow-y: auto;
  max-height: calc(100vh - 280px);
}

.log-entry {
  display: grid;
  grid-template-columns: 50px 90px 60px 1fr;
  gap: 12px;
  padding: 4px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}

.log-entry__line {
  color: rgba(255, 255, 255, 0.3);
  text-align: right;
  user-select: none;
}

.log-entry__time {
  color: rgba(255, 255, 255, 0.5);
}

.log-entry__level {
  font-weight: 600;
  text-transform: uppercase;
}

.log-entry--debug .log-entry__level { color: #6b7280; }
.log-entry--info .log-entry__level { color: #3b82f6; }
.log-entry--warn .log-entry__level { color: #f59e0b; }
.log-entry--error .log-entry__level { color: #ef4444; }

.log-entry__message {
  white-space: pre-wrap;
  word-break: break-word;
}

.log-entry--highlight {
  background: rgba(245, 159, 74, 0.15);
}
```

## Implementation Steps

1. **Read current logs.ts** - Understand existing structure and props
2. **Add icon import** - `import { icon } from "../icons";`
3. **Update header** - Card header with icon
4. **Create toolbar** - Search, level filters, actions
5. **Build terminal view** - Monospace log display
6. **Add level badges** - Color-coded log levels
7. **Implement search highlight** - Mark matching text
8. **Add status bar** - Entry counts, live indicator
9. **Add CSS to components.css** - Terminal styles
10. **Test build** - Run `pnpm build` to verify no errors

## Example Log Entry Pattern

```typescript
html`
  <div class="log-entry log-entry--${entry.level}">
    <span class="log-entry__line">${index + 1}</span>
    <span class="log-entry__time">${formatTime(entry.timestamp)}</span>
    <span class="log-entry__level">${entry.level}</span>
    <span class="log-entry__message">${highlightSearch(entry.message, searchTerm)}</span>
  </div>
`
```

## Example Level Filter Buttons

```typescript
html`
  <div class="logs-toolbar__levels">
    ${["debug", "info", "warn", "error"].map(level => html`
      <button
        class="logs-level-btn logs-level-btn--${level} ${levelFilters[level] ? "logs-level-btn--active" : ""}"
        @click=${() => onLevelToggle(level, !levelFilters[level])}
        title="${level.toUpperCase()}"
      >
        ${level.toUpperCase()}
      </button>
    `)}
  </div>
`
```

## Testing
After changes, run:
```bash
cd ui && pnpm build
```

Build should complete without errors.
