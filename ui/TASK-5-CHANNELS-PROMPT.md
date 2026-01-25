# Task 5: Redesign Channels View with Integration Cards

## Overview
Redesign the channels view (`ui/src/ui/views/channels.ts`) with modern integration card patterns, better status indicators, and improved channel management UX.

## Project Context

### Tech Stack
- **Framework**: Lit (Web Components) - NOT React
- **Styling**: Tailwind CSS v4 with CSS-first configuration
- **Build**: Vite
- **Icons**: Custom SVG icon system in `ui/src/ui/icons.ts`

### Key Files
- View to modify: `ui/src/ui/views/channels.ts`
- Related files: `ui/src/ui/views/channels.*.ts` (sub-components)
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
--accent-2: #34c7b7;
--ok: #2bd97f;
--warn: #f2c94c;
--danger: #ff6b6b;
--focus: rgba(245, 159, 74, 0.35);
```

### Icon System Usage
```typescript
import { icon } from "../icons";

// In template:
${icon("link", { size: 20 })}
${icon("check", { size: 16, class: "status-icon" })}
```

Available icons: `message-square`, `layout-dashboard`, `link`, `radio`, `file-text`, `clock`, `zap`, `server`, `settings`, `bug`, `scroll-text`, `book-open`, `chevron-down`, `chevron-right`, `chevron-left`, `menu`, `x`, `sun`, `moon`, `monitor`, `refresh-cw`, `maximize`, `brain`, `sparkles`, `user`, `log-out`, `check`, `alert-circle`, `info`, `alert-triangle`, `plus`, `minus`, `search`, `filter`, `more-vertical`, `edit`, `trash`, `copy`, `external-link`, `play`, `pause`, `stop`, `send`, `panel-left`

### Pattern Examples (from completed work)

#### Card with Icon Header
```typescript
html`
  <div class="card">
    <div class="card-header">
      <div class="card-header__icon">${icon("link", { size: 20 })}</div>
      <div>
        <div class="card-title">Channel Name</div>
        <div class="card-sub">Status description</div>
      </div>
    </div>
    <!-- content -->
  </div>
`
```

#### Status Indicator
```typescript
html`
  <div class="stat stat--modern ${connected ? "stat--ok" : "stat--warn"}">
    <div class="stat__icon">
      ${connected ? icon("check", { size: 18 }) : icon("alert-circle", { size: 18 })}
    </div>
    <div class="stat__content">
      <div class="stat-label">Status</div>
      <div class="stat-value">${connected ? "Connected" : "Disconnected"}</div>
    </div>
  </div>
`
```

#### Callout/Alert
```typescript
html`
  <div class="callout callout--info">
    <div class="callout__icon">${icon("info", { size: 18 })}</div>
    <div class="callout__content">Message text here</div>
  </div>
`
```

## Design Requirements

### Visual Style
1. **Integration cards** - Each channel as a distinct card with logo/icon area
2. **Status badges** - Connected/disconnected/error states with color coding
3. **Glass morphism** - Subtle transparency effects
4. **Gradient accents** - Use accent colors for active/connected states
5. **Smooth transitions** - 180ms animations on state changes

### Channels View Specific Requirements
1. **Channel grid** - Responsive grid of channel cards
2. **Status indicators** - Clear connected/disconnected/error states
3. **Quick actions** - Configure, refresh, connect/disconnect buttons
4. **Account counts** - Show number of accounts per channel
5. **Error display** - Clear error messages with troubleshooting hints
6. **WhatsApp QR** - Special handling for QR code display
7. **Channel logos** - Visual identification (can use colored icons)

### Suggested Layout
```
┌─────────────────────────────────────────────────┐
│ Channels Header (title, refresh, probe button)  │
├─────────────────────────────────────────────────┤
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ │
│ │ WhatsApp    │ │ Telegram    │ │ Discord     │ │
│ │ ●Connected  │ │ ●Connected  │ │ ○Offline    │ │
│ │ 2 accounts  │ │ 1 account   │ │ Configure   │ │
│ │ [Configure] │ │ [Configure] │ │ [Connect]   │ │
│ └─────────────┘ └─────────────┘ └─────────────┘ │
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ │
│ │ Signal      │ │ iMessage    │ │ Slack       │ │
│ │ ○Offline    │ │ ●Connected  │ │ ○Offline    │ │
│ │ Configure   │ │ 1 account   │ │ Configure   │ │
│ │ [Connect]   │ │ [Configure] │ │ [Connect]   │ │
│ └─────────────┘ └─────────────┘ └─────────────┘ │
└─────────────────────────────────────────────────┘
```

### Channel Card States
1. **Connected** - Green accent, check icon, account count
2. **Disconnected** - Muted styling, prompt to connect
3. **Error** - Red accent, error icon, error message
4. **Loading** - Spinner/pulse animation
5. **Configuring** - Expanded with config form

## CSS Classes to Add (append to components.css)

```css
/* Channel View Styles */
.channels-grid { /* responsive grid container */ }
.channel-card { /* individual channel card */ }
.channel-card--connected { /* connected state */ }
.channel-card--error { /* error state */ }
.channel-card--loading { /* loading state */ }
.channel-card__header { /* logo + name area */ }
.channel-card__logo { /* channel icon/logo */ }
.channel-card__status { /* status badge */ }
.channel-card__accounts { /* account count */ }
.channel-card__actions { /* action buttons */ }
.channel-card__error { /* error message */ }
.channel-card__config { /* expanded config form */ }
.channel-qr { /* QR code container for WhatsApp */ }
.channel-qr__image { /* QR code image */ }
.channel-qr__message { /* QR instructions */ }
```

### Channel-Specific Colors (suggested)
```css
.channel-card--whatsapp { --channel-color: #25D366; }
.channel-card--telegram { --channel-color: #0088cc; }
.channel-card--discord { --channel-color: #5865F2; }
.channel-card--signal { --channel-color: #3A76F0; }
.channel-card--imessage { --channel-color: #34C759; }
.channel-card--slack { --channel-color: #4A154B; }
```

## Implementation Steps

1. **Read current channels.ts** - Understand existing structure and props
2. **Add icon import** - `import { icon } from "../icons";`
3. **Create channel card component** - Reusable card for each channel
4. **Update grid layout** - Responsive grid of channel cards
5. **Add status indicators** - Connected/error/loading states
6. **Improve action buttons** - Icon buttons with hover states
7. **Style QR code section** - Better WhatsApp QR display
8. **Add CSS to components.css** - New channel-specific styles
9. **Test build** - Run `pnpm build` to verify no errors

## Testing
After changes, run:
```bash
cd ui && pnpm build
```

Build should complete without errors.
