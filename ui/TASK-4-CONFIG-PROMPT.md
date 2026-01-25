# Task 4: Redesign Config/Settings View

## Overview
Redesign the config/settings view (`ui/src/ui/views/config.ts`) with modern form patterns, better visual hierarchy, and improved UX.

## Project Context

### Tech Stack
- **Framework**: Lit (Web Components) - NOT React
- **Styling**: Tailwind CSS v4 with CSS-first configuration
- **Build**: Vite
- **Icons**: Custom SVG icon system in `ui/src/ui/icons.ts`

### Key Files
- View to modify: `ui/src/ui/views/config.ts`
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
--accent-glow: rgba(245, 159, 74, 0.4);
--ok: #2bd97f;
--warn: #f2c94c;
--danger: #ff6b6b;
--focus: rgba(245, 159, 74, 0.35);
```

### Icon System Usage
```typescript
import { icon } from "../icons";

// In template:
${icon("settings", { size: 20 })}
${icon("check", { size: 16, class: "my-class" })}
```

Available icons: `message-square`, `layout-dashboard`, `link`, `radio`, `file-text`, `clock`, `zap`, `server`, `settings`, `bug`, `scroll-text`, `book-open`, `chevron-down`, `chevron-right`, `chevron-left`, `menu`, `x`, `sun`, `moon`, `monitor`, `refresh-cw`, `maximize`, `brain`, `sparkles`, `user`, `log-out`, `check`, `alert-circle`, `info`, `alert-triangle`, `plus`, `minus`, `search`, `filter`, `more-vertical`, `edit`, `trash`, `copy`, `external-link`, `play`, `pause`, `stop`, `send`, `panel-left`

### Pattern Examples (from completed overview.ts)

#### Card with Icon Header
```typescript
html`
  <div class="card">
    <div class="card-header">
      <div class="card-header__icon">${icon("settings", { size: 20 })}</div>
      <div>
        <div class="card-title">Section Title</div>
        <div class="card-sub">Description text</div>
      </div>
    </div>
    <!-- content -->
  </div>
`
```

#### Modern Form Field
```typescript
html`
  <label class="field field--modern">
    <span class="field__label">Label Text</span>
    <div class="field__input-wrapper">
      ${icon("server", { size: 16, class: "field__icon" })}
      <input class="field__input" .value=${value} @input=${handler} />
    </div>
  </label>
`
```

#### Button with Icon
```typescript
html`
  <button class="btn btn--primary" @click=${handler}>
    ${icon("check", { size: 16 })}
    <span>Save</span>
  </button>
`
```

## Design Requirements

### Visual Style
1. **Glass morphism** - Subtle transparency with backdrop blur
2. **Gradient backgrounds** - Use `linear-gradient(135deg, ...)` patterns
3. **Accent color highlights** - Orange (#f59f4a) for active/focus states
4. **Smooth transitions** - 180ms cubic-bezier(0.4, 0, 0.2, 1)
5. **Consistent border radius** - 10-16px for cards, 8-12px for inputs

### Config View Specific Requirements
1. **Section navigation** - Sidebar or tabs for config sections
2. **Search/filter** - Quick search through config options
3. **Form vs Raw toggle** - Switch between form UI and raw JSON/YAML
4. **Validation feedback** - Clear error states with icons
5. **Save/Apply actions** - Prominent action buttons with loading states
6. **Dirty state indicator** - Show when changes are unsaved

### Suggested Layout
```
┌─────────────────────────────────────────────────┐
│ Config Header (title, search, mode toggle)      │
├──────────┬──────────────────────────────────────┤
│ Sections │ Active Section Content               │
│ Nav      │                                      │
│          │ ┌─────────────────────────────────┐  │
│ General  │ │ Field Group                     │  │
│ Agents   │ │ ┌─────────┐ ┌─────────┐        │  │
│ Channels │ │ │ Input   │ │ Input   │        │  │
│ Tools    │ │ └─────────┘ └─────────┘        │  │
│ Advanced │ └─────────────────────────────────┘  │
│          │                                      │
└──────────┴──────────────────────────────────────┘
│ Actions: Save | Apply | Reload                  │
└─────────────────────────────────────────────────┘
```

## CSS Classes to Add (append to components.css)

```css
/* Config View Styles */
.config-layout { /* main container */ }
.config-sidebar { /* section navigation */ }
.config-sidebar__item { /* nav item */ }
.config-sidebar__item--active { /* active state */ }
.config-content { /* main content area */ }
.config-header { /* header with search/toggle */ }
.config-search { /* search input */ }
.config-mode-toggle { /* form/raw toggle */ }
.config-section { /* section container */ }
.config-field-group { /* group of related fields */ }
.config-actions { /* save/apply buttons */ }
.config-dirty-indicator { /* unsaved changes badge */ }
```

## Implementation Steps

1. **Read current config.ts** - Understand existing structure and props
2. **Add icon import** - `import { icon } from "../icons";`
3. **Update template** - Apply new card/field patterns
4. **Add section navigation** - Sidebar or tabs for config sections
5. **Improve form fields** - Use field--modern pattern with icons
6. **Add CSS to components.css** - New config-specific styles
7. **Test build** - Run `pnpm build` to verify no errors

## Testing
After changes, run:
```bash
cd ui && pnpm build
```

Build should complete without errors. The CSS file size will increase slightly.
