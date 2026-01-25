# Task 6: Redesign Sessions/Cron/Skills Data Tables

## Overview
Redesign the data table views for Sessions, Cron, and Skills with modern table patterns, better row styling, and improved data presentation.

## Project Context

### Tech Stack
- **Framework**: Lit (Web Components) - NOT React
- **Styling**: Tailwind CSS v4 with CSS-first configuration
- **Build**: Vite
- **Icons**: Custom SVG icon system in `ui/src/ui/icons.ts`

### Key Files
- Sessions view: `ui/src/ui/views/sessions.ts`
- Cron view: `ui/src/ui/views/cron.ts`
- Skills view: `ui/src/ui/views/skills.ts`
- Styles: `ui/src/styles/components.css` (append new styles)
- Icons: `ui/src/ui/icons.ts` (import and use `icon()` function)
- Design tokens: `ui/src/styles/base.css` (CSS variables)

## Design System Reference

### CSS Variables (from base.css)
```css
/* Dark theme */
--bg: #0a0f14;
--panel: rgba(14, 20, 30, 0.88);
--panel-rgb: 14, 20, 30;
--text: rgba(244, 246, 251, 0.96);
--muted: rgba(156, 169, 189, 0.72);
--border: rgba(255, 255, 255, 0.09);
--border-strong: rgba(255, 255, 255, 0.16);
--accent: #f59f4a;
--ok: #2bd97f;
--warn: #f2c94c;
--danger: #ff6b6b;
```

### Icon System Usage
```typescript
import { icon } from "../icons";

// In template:
${icon("file-text", { size: 18 })}
${icon("clock", { size: 16 })}
${icon("zap", { size: 16 })}
```

Available icons: `message-square`, `layout-dashboard`, `link`, `radio`, `file-text`, `clock`, `zap`, `server`, `settings`, `bug`, `scroll-text`, `book-open`, `chevron-down`, `chevron-right`, `chevron-left`, `menu`, `x`, `sun`, `moon`, `monitor`, `refresh-cw`, `maximize`, `brain`, `sparkles`, `user`, `log-out`, `check`, `alert-circle`, `info`, `alert-triangle`, `plus`, `minus`, `search`, `filter`, `more-vertical`, `edit`, `trash`, `copy`, `external-link`, `play`, `pause`, `stop`, `send`, `panel-left`

### Pattern Examples

#### Card Header
```typescript
html`
  <div class="card-header">
    <div class="card-header__icon">${icon("file-text", { size: 20 })}</div>
    <div>
      <div class="card-title">Sessions</div>
      <div class="card-sub">Active conversation sessions</div>
    </div>
  </div>
`
```

#### Status Badge
```typescript
html`
  <span class="badge badge--${status}">
    ${icon(statusIcon, { size: 12 })}
    <span>${statusText}</span>
  </span>
`
```

#### Action Button
```typescript
html`
  <button class="btn btn--sm btn--icon" title="Edit">
    ${icon("edit", { size: 14 })}
  </button>
`
```

## Design Requirements

### Visual Style
1. **Clean table rows** - Alternating backgrounds, hover states
2. **Status badges** - Color-coded with icons
3. **Inline actions** - Icon buttons that appear on hover
4. **Sortable headers** - Click to sort with indicator
5. **Filters bar** - Search and filter controls above table
6. **Empty states** - Friendly message when no data

### Common Table Patterns
```
┌─────────────────────────────────────────────────┐
│ Table Header (title, filters, actions)          │
├─────────────────────────────────────────────────┤
│ Column Headers (sortable)                       │
├─────────────────────────────────────────────────┤
│ Row 1 │ Data │ Status │ Actions                 │
├─────────────────────────────────────────────────┤
│ Row 2 │ Data │ Status │ Actions                 │
├─────────────────────────────────────────────────┤
│ Row 3 │ Data │ Status │ Actions                 │
└─────────────────────────────────────────────────┘
│ Pagination / Load More                          │
└─────────────────────────────────────────────────┘
```

## View-Specific Requirements

### Sessions View
- **Session key** - Monospace, truncatable with copy button
- **Agent** - Agent name/ID
- **Last active** - Relative timestamp
- **Message count** - Number badge
- **Actions** - Open chat, reset, delete
- **Filters** - By agent, active time, include global/unknown

### Cron View
- **Job name** - Primary identifier
- **Schedule** - Cron expression with human-readable
- **Status** - Enabled/disabled toggle
- **Next run** - Countdown or timestamp
- **Last run** - Result with status indicator
- **Actions** - Run now, edit, delete
- **Add job form** - Expandable form at top

### Skills View
- **Skill name** - With icon if available
- **Status** - Enabled/disabled/error
- **API key status** - Configured/missing indicator
- **Actions** - Enable/disable, configure, install
- **Skill details** - Expandable row with more info
- **Filters** - By status, search by name

## CSS Classes to Add (append to components.css)

```css
/* Modern Data Table Styles */
.data-table { /* table container */ }
.data-table__header { /* sticky header row */ }
.data-table__header-cell { /* column header */ }
.data-table__header-cell--sortable { /* sortable column */ }
.data-table__header-cell--sorted { /* active sort */ }
.data-table__body { /* scrollable body */ }
.data-table__row { /* data row */ }
.data-table__row:hover { /* hover state */ }
.data-table__row--selected { /* selected row */ }
.data-table__cell { /* data cell */ }
.data-table__cell--mono { /* monospace text */ }
.data-table__cell--actions { /* action buttons */ }
.data-table__empty { /* empty state */ }

/* Table Filters */
.table-filters { /* filter bar container */ }
.table-filters__search { /* search input */ }
.table-filters__select { /* filter dropdown */ }
.table-filters__toggle { /* toggle filter */ }

/* Status Badges */
.badge { /* base badge */ }
.badge--ok { /* success/enabled */ }
.badge--warn { /* warning */ }
.badge--danger { /* error/disabled */ }
.badge--muted { /* neutral */ }

/* Row Actions */
.row-actions { /* action buttons container */ }
.row-actions__btn { /* action button */ }

/* Expandable Row */
.expandable-row { /* expandable content */ }
.expandable-row--open { /* expanded state */ }
.expandable-row__content { /* inner content */ }

/* Sessions Specific */
.session-key { /* session key display */ }
.session-key__copy { /* copy button */ }

/* Cron Specific */
.cron-schedule { /* schedule display */ }
.cron-schedule__expr { /* cron expression */ }
.cron-schedule__human { /* human readable */ }
.cron-next-run { /* next run countdown */ }

/* Skills Specific */
.skill-row { /* skill row */ }
.skill-row__icon { /* skill icon */ }
.skill-row__api-status { /* API key status */ }
```

## Implementation Steps

### For Each View (sessions.ts, cron.ts, skills.ts):

1. **Read current file** - Understand existing structure and props
2. **Add icon import** - `import { icon } from "../icons";`
3. **Update card headers** - Use card-header pattern with icons
4. **Modernize table structure** - Apply data-table classes
5. **Add status badges** - Replace text with badge components
6. **Improve row actions** - Icon buttons with tooltips
7. **Add filter bar** - Search and filter controls
8. **Style empty states** - Friendly messages with icons
9. **Add CSS to components.css** - Table-specific styles
10. **Test build** - Run `pnpm build` to verify no errors

## Example Table Row Pattern

```typescript
html`
  <div class="data-table__row">
    <div class="data-table__cell data-table__cell--mono">
      <span class="session-key">${truncate(sessionKey, 24)}</span>
      <button class="session-key__copy" @click=${() => copyToClipboard(sessionKey)} title="Copy">
        ${icon("copy", { size: 12 })}
      </button>
    </div>
    <div class="data-table__cell">${agentName}</div>
    <div class="data-table__cell">${formatAgo(lastActive)}</div>
    <div class="data-table__cell">
      <span class="badge badge--${status}">${statusText}</span>
    </div>
    <div class="data-table__cell data-table__cell--actions">
      <div class="row-actions">
        <button class="row-actions__btn" title="Open Chat" @click=${onOpen}>
          ${icon("message-square", { size: 14 })}
        </button>
        <button class="row-actions__btn" title="Delete" @click=${onDelete}>
          ${icon("trash", { size: 14 })}
        </button>
      </div>
    </div>
  </div>
`
```

## Testing
After changes, run:
```bash
cd ui && pnpm build
```

Build should complete without errors.
