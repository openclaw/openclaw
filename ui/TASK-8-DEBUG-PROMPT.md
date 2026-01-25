# Task 8: Redesign Debug/RPC Console View

## Overview
Redesign the debug view (`ui/src/ui/views/debug.ts`) with a modern developer console aesthetic, better RPC call interface, and improved data visualization.

## Project Context

### Tech Stack
- **Framework**: Lit (Web Components) - NOT React
- **Styling**: Tailwind CSS v4 with CSS-first configuration
- **Build**: Vite
- **Icons**: Custom SVG icon system in `ui/src/ui/icons.ts`

### Key Files
- View to modify: `ui/src/ui/views/debug.ts`
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
--accent-2: #34c7b7;
--ok: #2bd97f;
--warn: #f2c94c;
--danger: #ff6b6b;
--mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
```

### Icon System Usage
```typescript
import { icon } from "../icons";

// In template:
${icon("bug", { size: 20 })}
${icon("play", { size: 16 })}
${icon("send", { size: 16 })}
```

Available icons: `message-square`, `layout-dashboard`, `link`, `radio`, `file-text`, `clock`, `zap`, `server`, `settings`, `bug`, `scroll-text`, `book-open`, `chevron-down`, `chevron-right`, `chevron-left`, `menu`, `x`, `sun`, `moon`, `monitor`, `refresh-cw`, `maximize`, `brain`, `sparkles`, `user`, `log-out`, `check`, `alert-circle`, `info`, `alert-triangle`, `plus`, `minus`, `search`, `filter`, `more-vertical`, `edit`, `trash`, `copy`, `external-link`, `play`, `pause`, `stop`, `send`, `panel-left`

## Design Requirements

### Visual Style - Developer Console
1. **Dark theme** - Deep dark background for console feel
2. **Monospace fonts** - For all code/data displays
3. **Syntax highlighting** - JSON output with colors
4. **Split panels** - Request on left, response on right
5. **Tabbed sections** - Status, Health, Models, RPC Console

### Debug View Specific Requirements
1. **System status panel** - Gateway status, uptime, health
2. **Health metrics** - Memory, connections, queues
3. **Models list** - Available AI models with status
4. **RPC console** - Method input, params editor, call button
5. **Response viewer** - JSON output with copy button
6. **Event log** - Recent gateway events
7. **Heartbeat status** - Last heartbeat indicator

### Suggested Layout
```
┌─────────────────────────────────────────────────┐
│ Debug Console Header                            │
├─────────────────────────────────────────────────┤
│ [Status] [Health] [Models] [RPC Console]        │
├─────────────────────────────────────────────────┤
│                                                 │
│  RPC Console Tab:                               │
│  ┌─────────────────┬───────────────────────┐   │
│  │ Method:         │ Response:             │   │
│  │ [sessions.list] │ ┌─────────────────┐   │   │
│  │                 │ │ {               │   │   │
│  │ Params (JSON):  │ │   "sessions": [ │   │   │
│  │ ┌─────────────┐ │ │     ...         │   │   │
│  │ │ {           │ │ │   ]             │   │   │
│  │ │   "limit":10│ │ │ }               │   │   │
│  │ │ }           │ │ └─────────────────┘   │   │
│  │ └─────────────┘ │ [Copy] [Clear]        │   │
│  │                 │                       │   │
│  │ [Execute ▶]     │ Error: (if any)       │   │
│  └─────────────────┴───────────────────────┘   │
│                                                 │
└─────────────────────────────────────────────────┘
```

### Status Panel Layout
```
┌─────────────────────────────────────────────────┐
│ Status Overview                                 │
├───────────────┬───────────────┬─────────────────┤
│ Gateway       │ Uptime        │ Heartbeat       │
│ ● Connected   │ 4h 32m        │ 2s ago          │
├───────────────┼───────────────┼─────────────────┤
│ Memory        │ Connections   │ Queue           │
│ 128 MB        │ 3 active      │ 0 pending       │
└───────────────┴───────────────┴─────────────────┘
```

## CSS Classes to Add (append to components.css)

```css
/* Debug Console Styles */
.debug-container { /* main container */ }
.debug-tabs { /* tab navigation */ }
.debug-tab { /* individual tab */ }
.debug-tab--active { /* active tab */ }
.debug-content { /* tab content area */ }

/* Status Panel */
.debug-status { /* status grid */ }
.debug-status__card { /* status card */ }
.debug-status__icon { /* status icon */ }
.debug-status__label { /* status label */ }
.debug-status__value { /* status value */ }
.debug-status__ok { /* healthy state */ }
.debug-status__warn { /* warning state */ }
.debug-status__error { /* error state */ }

/* RPC Console */
.rpc-console { /* console container */ }
.rpc-console__input { /* input panel */ }
.rpc-console__output { /* output panel */ }

.rpc-method { /* method input */ }
.rpc-method__label { /* method label */ }
.rpc-method__input { /* method text input */ }
.rpc-method__suggestions { /* autocomplete dropdown */ }

.rpc-params { /* params editor */ }
.rpc-params__label { /* params label */ }
.rpc-params__editor { /* JSON textarea */ }

.rpc-execute { /* execute button */ }

.rpc-response { /* response container */ }
.rpc-response__header { /* response header */ }
.rpc-response__body { /* response JSON */ }
.rpc-response__error { /* error message */ }
.rpc-response__actions { /* copy/clear buttons */ }

/* JSON Viewer */
.json-viewer { /* JSON display */ }
.json-viewer__string { color: #a5d6ff; }
.json-viewer__number { color: #79c0ff; }
.json-viewer__boolean { color: #ff7b72; }
.json-viewer__null { color: #8b949e; }
.json-viewer__key { color: #7ee787; }
.json-viewer__bracket { color: #8b949e; }

/* Event Log */
.event-log { /* event log container */ }
.event-log__entry { /* log entry */ }
.event-log__time { /* timestamp */ }
.event-log__type { /* event type badge */ }
.event-log__data { /* event data */ }

/* Health Metrics */
.health-grid { /* metrics grid */ }
.health-metric { /* individual metric */ }
.health-metric__label { /* metric name */ }
.health-metric__value { /* metric value */ }
.health-metric__bar { /* progress bar */ }

/* Models List */
.models-list { /* models container */ }
.model-card { /* individual model */ }
.model-card__name { /* model name */ }
.model-card__provider { /* provider badge */ }
.model-card__status { /* availability status */ }
```

## Implementation Steps

1. **Read current debug.ts** - Understand existing structure and props
2. **Add icon import** - `import { icon } from "../icons";`
3. **Create tab navigation** - Status, Health, Models, RPC tabs
4. **Build status panel** - System status overview cards
5. **Build RPC console** - Split panel with input/output
6. **Add JSON syntax highlighting** - Color-coded JSON display
7. **Style execute button** - Prominent action button
8. **Add event log** - Recent events with timestamps
9. **Add CSS to components.css** - Debug console styles
10. **Test build** - Run `pnpm build` to verify no errors

## Example RPC Console Pattern

```typescript
html`
  <div class="rpc-console">
    <div class="rpc-console__input">
      <div class="rpc-method">
        <label class="rpc-method__label">Method</label>
        <input
          class="rpc-method__input"
          .value=${callMethod}
          @input=${(e: Event) => onCallMethodChange((e.target as HTMLInputElement).value)}
          placeholder="sessions.list"
        />
      </div>
      <div class="rpc-params">
        <label class="rpc-params__label">Parameters (JSON)</label>
        <textarea
          class="rpc-params__editor"
          .value=${callParams}
          @input=${(e: Event) => onCallParamsChange((e.target as HTMLTextAreaElement).value)}
          placeholder='{ "limit": 10 }'
        ></textarea>
      </div>
      <button class="rpc-execute btn btn--primary" @click=${onCall}>
        ${icon("play", { size: 16 })}
        <span>Execute</span>
      </button>
    </div>
    <div class="rpc-console__output">
      <div class="rpc-response__header">
        <span>Response</span>
        <div class="rpc-response__actions">
          <button class="btn btn--sm" @click=${copyResponse} title="Copy">
            ${icon("copy", { size: 14 })}
          </button>
        </div>
      </div>
      <div class="rpc-response__body">
        ${callError
          ? html`<div class="rpc-response__error">${callError}</div>`
          : html`<pre class="json-viewer">${formatJson(callResult)}</pre>`}
      </div>
    </div>
  </div>
`
```

## Example Status Card Pattern

```typescript
html`
  <div class="debug-status__card ${connected ? "debug-status__ok" : "debug-status__error"}">
    <div class="debug-status__icon">
      ${connected ? icon("check", { size: 20 }) : icon("alert-circle", { size: 20 })}
    </div>
    <div class="debug-status__label">Gateway</div>
    <div class="debug-status__value">${connected ? "Connected" : "Disconnected"}</div>
  </div>
`
```

## Testing
After changes, run:
```bash
cd ui && pnpm build
```

Build should complete without errors.
