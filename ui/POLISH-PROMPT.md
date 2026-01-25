# Task 10: Global UI Polish - Toasts, Command Palette, Animations

## Overview
Add final UI polish across the entire application including toast notifications, command palette, micro-animations, and consistency fixes.

## IMPORTANT: Run This Task LAST
This task should be run AFTER all other view redesigns (Tasks 1-9) are complete. It adds global polish and ensures consistency across all views.

## Project Context

### Tech Stack
- **Framework**: Lit (Web Components) - NOT React
- **Styling**: Tailwind CSS v4 with CSS-first configuration
- **Build**: Vite
- **Icons**: Custom SVG icon system in `ui/src/ui/icons.ts`

### Key Files to Modify
- New file: `ui/src/ui/components/toast.ts` (create)
- New file: `ui/src/ui/components/command-palette.ts` (create)
- Styles: `ui/src/styles/components.css` (append new styles)
- Animation styles: `ui/src/styles/design-system.css` (has keyframes)
- Main app: `ui/src/ui/app-render.ts` (integrate components)
- App state: `ui/src/ui/app-view-state.ts` (add toast/palette state)

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

### Existing Keyframe Animations (from design-system.css)
```css
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes fadeInUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
@keyframes fadeInDown { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
@keyframes slideInRight { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
@keyframes slideInLeft { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
@keyframes scaleIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
@keyframes pulseGlow { 0%, 100% { box-shadow: 0 0 5px var(--accent-glow); } 50% { box-shadow: 0 0 20px var(--accent-glow); } }
@keyframes shimmer { from { background-position: -200% 0; } to { background-position: 200% 0; } }
```

### Icon System Usage
```typescript
import { icon } from "../icons";

${icon("check", { size: 16 })}
${icon("x", { size: 16 })}
${icon("search", { size: 18 })}
```

## Part 1: Toast Notification System

### Toast Types
1. **Success** - Green, check icon, auto-dismiss
2. **Error** - Red, alert icon, manual dismiss
3. **Warning** - Yellow, warning icon, auto-dismiss
4. **Info** - Blue, info icon, auto-dismiss

### Toast Component Structure
```typescript
// ui/src/ui/components/toast.ts
import { html, nothing } from "lit";
import { icon } from "../icons";

export type ToastType = "success" | "error" | "warning" | "info";

export type Toast = {
  id: string;
  type: ToastType;
  message: string;
  duration?: number; // ms, 0 = no auto-dismiss
};

export type ToastState = {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, "id">) => void;
  removeToast: (id: string) => void;
};

export function renderToastContainer(state: ToastState) {
  return html`
    <div class="toast-container">
      ${state.toasts.map(toast => renderToast(toast, state.removeToast))}
    </div>
  `;
}

function renderToast(toast: Toast, onDismiss: (id: string) => void) {
  const icons = {
    success: "check",
    error: "alert-circle",
    warning: "alert-triangle",
    info: "info",
  };

  return html`
    <div class="toast toast--${toast.type}" role="alert">
      <div class="toast__icon">${icon(icons[toast.type], { size: 18 })}</div>
      <div class="toast__message">${toast.message}</div>
      <button class="toast__dismiss" @click=${() => onDismiss(toast.id)}>
        ${icon("x", { size: 14 })}
      </button>
    </div>
  `;
}
```

### Toast CSS
```css
/* Toast Notifications */
.toast-container {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 12px;
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--panel-strong);
  border: 1px solid var(--border-strong);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(12px);
  animation: slideInRight 0.3s ease-out;
  pointer-events: auto;
  max-width: 400px;
}

.toast--success {
  border-color: rgba(43, 217, 127, 0.4);
  background: linear-gradient(135deg, rgba(43, 217, 127, 0.15), var(--panel-strong));
}

.toast--error {
  border-color: rgba(255, 107, 107, 0.4);
  background: linear-gradient(135deg, rgba(255, 107, 107, 0.15), var(--panel-strong));
}

.toast--warning {
  border-color: rgba(242, 201, 76, 0.4);
  background: linear-gradient(135deg, rgba(242, 201, 76, 0.15), var(--panel-strong));
}

.toast--info {
  border-color: rgba(52, 199, 183, 0.4);
  background: linear-gradient(135deg, rgba(52, 199, 183, 0.15), var(--panel-strong));
}

.toast__icon {
  flex-shrink: 0;
}

.toast--success .toast__icon { color: var(--ok); }
.toast--error .toast__icon { color: var(--danger); }
.toast--warning .toast__icon { color: var(--warn); }
.toast--info .toast__icon { color: var(--accent-2); }

.toast__message {
  flex: 1;
  font-size: 13px;
  line-height: 1.4;
}

.toast__dismiss {
  flex-shrink: 0;
  padding: 4px;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  border-radius: 6px;
  transition: color 150ms ease, background 150ms ease;
}

.toast__dismiss:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.1);
}

/* Toast exit animation */
.toast--exiting {
  animation: fadeOut 0.2s ease-out forwards;
}

@keyframes fadeOut {
  to { opacity: 0; transform: translateX(20px); }
}
```

## Part 2: Command Palette (Cmd+K)

### Command Palette Features
1. **Quick navigation** - Jump to any tab
2. **Actions** - Common actions (refresh, new session, etc.)
3. **Search** - Filter commands as you type
4. **Keyboard nav** - Arrow keys, Enter to select, Esc to close

### Command Palette Structure
```typescript
// ui/src/ui/components/command-palette.ts
import { html, nothing } from "lit";
import { icon } from "../icons";

export type Command = {
  id: string;
  label: string;
  icon: string;
  shortcut?: string;
  action: () => void;
  category?: string;
};

export type CommandPaletteState = {
  open: boolean;
  query: string;
  selectedIndex: number;
  commands: Command[];
};

export function renderCommandPalette(
  state: CommandPaletteState,
  onClose: () => void,
  onQueryChange: (query: string) => void,
  onSelect: (command: Command) => void,
  onIndexChange: (index: number) => void,
) {
  if (!state.open) return nothing;

  const filtered = state.commands.filter(cmd =>
    cmd.label.toLowerCase().includes(state.query.toLowerCase())
  );

  return html`
    <div class="command-palette-overlay" @click=${onClose}>
      <div class="command-palette" @click=${(e: Event) => e.stopPropagation()}>
        <div class="command-palette__search">
          ${icon("search", { size: 18, class: "command-palette__search-icon" })}
          <input
            class="command-palette__input"
            type="text"
            placeholder="Type a command..."
            .value=${state.query}
            @input=${(e: Event) => onQueryChange((e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => handlePaletteKeydown(e, state, filtered, onClose, onSelect, onIndexChange)}
            autofocus
          />
          <kbd class="command-palette__kbd">ESC</kbd>
        </div>
        <div class="command-palette__list">
          ${filtered.map((cmd, i) => html`
            <button
              class="command-palette__item ${i === state.selectedIndex ? "command-palette__item--selected" : ""}"
              @click=${() => onSelect(cmd)}
              @mouseenter=${() => onIndexChange(i)}
            >
              <span class="command-palette__item-icon">${icon(cmd.icon, { size: 16 })}</span>
              <span class="command-palette__item-label">${cmd.label}</span>
              ${cmd.shortcut ? html`<kbd class="command-palette__item-shortcut">${cmd.shortcut}</kbd>` : nothing}
            </button>
          `)}
          ${filtered.length === 0 ? html`
            <div class="command-palette__empty">No commands found</div>
          ` : nothing}
        </div>
      </div>
    </div>
  `;
}

function handlePaletteKeydown(
  e: KeyboardEvent,
  state: CommandPaletteState,
  filtered: Command[],
  onClose: () => void,
  onSelect: (cmd: Command) => void,
  onIndexChange: (index: number) => void,
) {
  switch (e.key) {
    case "Escape":
      onClose();
      break;
    case "ArrowDown":
      e.preventDefault();
      onIndexChange(Math.min(state.selectedIndex + 1, filtered.length - 1));
      break;
    case "ArrowUp":
      e.preventDefault();
      onIndexChange(Math.max(state.selectedIndex - 1, 0));
      break;
    case "Enter":
      e.preventDefault();
      if (filtered[state.selectedIndex]) {
        onSelect(filtered[state.selectedIndex]);
      }
      break;
  }
}
```

### Command Palette CSS
```css
/* Command Palette */
.command-palette-overlay {
  position: fixed;
  inset: 0;
  z-index: 1100;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  justify-content: center;
  padding-top: 15vh;
  animation: fadeIn 0.15s ease-out;
}

.command-palette {
  width: 100%;
  max-width: 560px;
  background: var(--panel-strong);
  border: 1px solid var(--border-strong);
  border-radius: 16px;
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  animation: scaleIn 0.2s ease-out;
}

.command-palette__search {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.command-palette__search-icon {
  color: var(--muted);
  flex-shrink: 0;
}

.command-palette__input {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 16px;
  outline: none;
}

.command-palette__input::placeholder {
  color: var(--muted);
}

.command-palette__kbd {
  padding: 4px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--border);
  font-size: 11px;
  font-family: var(--mono);
  color: var(--muted);
}

.command-palette__list {
  max-height: 400px;
  overflow-y: auto;
  padding: 8px;
}

.command-palette__item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 14px;
  border: none;
  background: transparent;
  color: var(--text);
  text-align: left;
  border-radius: 10px;
  cursor: pointer;
  transition: background 150ms ease;
}

.command-palette__item:hover,
.command-palette__item--selected {
  background: rgba(255, 255, 255, 0.08);
}

.command-palette__item--selected {
  background: rgba(245, 159, 74, 0.12);
  outline: 1px solid rgba(245, 159, 74, 0.3);
}

.command-palette__item-icon {
  color: var(--muted);
  flex-shrink: 0;
}

.command-palette__item-label {
  flex: 1;
  font-size: 14px;
}

.command-palette__item-shortcut {
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  font-size: 11px;
  font-family: var(--mono);
  color: var(--muted);
}

.command-palette__empty {
  padding: 24px;
  text-align: center;
  color: var(--muted);
}
```

## Part 3: Micro-Animations & Polish

### Add to components.css
```css
/* =============================================================================
   GLOBAL MICRO-ANIMATIONS
   ============================================================================= */

/* Button press effect */
.btn:active:not(:disabled) {
  transform: scale(0.98);
}

/* Card hover lift */
.card {
  transition: transform 200ms ease, box-shadow 200ms ease, border-color 200ms ease;
}

.card:hover {
  transform: translateY(-2px);
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.35);
}

/* Input focus glow */
input:focus,
textarea:focus,
select:focus {
  transition: border-color 180ms ease, box-shadow 180ms ease;
}

/* Badge pulse for active states */
.badge--pulse {
  animation: pulseGlow 2s ease-in-out infinite;
}

/* Loading skeleton shimmer */
.skeleton {
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0.04) 0%,
    rgba(255, 255, 255, 0.08) 50%,
    rgba(255, 255, 255, 0.04) 100%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s linear infinite;
  border-radius: 8px;
}

/* Status dot pulse */
.status-dot--pulse {
  animation: statusPulse 2s ease-in-out infinite;
}

@keyframes statusPulse {
  0%, 100% { box-shadow: 0 0 0 0 currentColor; }
  50% { box-shadow: 0 0 0 4px transparent; }
}

/* Smooth page transitions */
.content > section {
  animation: fadeInUp 0.3s ease-out;
}

/* List item stagger animation */
.stagger-item {
  opacity: 0;
  animation: fadeInUp 0.3s ease-out forwards;
}

.stagger-item:nth-child(1) { animation-delay: 0ms; }
.stagger-item:nth-child(2) { animation-delay: 50ms; }
.stagger-item:nth-child(3) { animation-delay: 100ms; }
.stagger-item:nth-child(4) { animation-delay: 150ms; }
.stagger-item:nth-child(5) { animation-delay: 200ms; }
.stagger-item:nth-child(n+6) { animation-delay: 250ms; }

/* Tooltip */
[data-tooltip] {
  position: relative;
}

[data-tooltip]::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%) translateY(-4px);
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--panel-strong);
  border: 1px solid var(--border-strong);
  font-size: 12px;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 150ms ease, transform 150ms ease;
}

[data-tooltip]:hover::after {
  opacity: 1;
  transform: translateX(-50%) translateY(-8px);
}

/* Focus visible ring */
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* Reduced motion preference */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

## Part 4: Consistency Checks

### Review all views for:
1. **Icon usage** - All icons use `icon()` function from icons.ts
2. **Button styling** - Consistent `btn`, `btn--primary`, `btn--secondary`, `btn--danger` classes
3. **Card patterns** - All cards use `card-header` with icon pattern
4. **Form fields** - All inputs use `field--modern` pattern
5. **Status indicators** - Consistent color coding (ok=green, warn=yellow, danger=red)
6. **Loading states** - Skeleton placeholders or spinners
7. **Empty states** - Friendly messages with icons
8. **Spacing** - Consistent margins and gaps

## Implementation Steps

1. **Create toast component** - `ui/src/ui/components/toast.ts`
2. **Create command palette** - `ui/src/ui/components/command-palette.ts`
3. **Add keyboard listener** - Cmd/Ctrl+K to open palette
4. **Integrate into app-render.ts** - Render toast container and palette
5. **Add toast/palette state** - Update app-view-state.ts
6. **Add all CSS** - Append to components.css
7. **Review all views** - Check consistency
8. **Test animations** - Verify smooth transitions
9. **Test reduced motion** - Verify accessibility
10. **Final build** - Run `pnpm build`

## Default Commands for Palette

```typescript
const defaultCommands: Command[] = [
  { id: "nav-chat", label: "Go to Chat", icon: "message-square", action: () => setTab("chat") },
  { id: "nav-overview", label: "Go to Overview", icon: "layout-dashboard", action: () => setTab("overview") },
  { id: "nav-channels", label: "Go to Channels", icon: "link", action: () => setTab("channels") },
  { id: "nav-sessions", label: "Go to Sessions", icon: "file-text", action: () => setTab("sessions") },
  { id: "nav-config", label: "Go to Config", icon: "settings", action: () => setTab("config") },
  { id: "nav-logs", label: "Go to Logs", icon: "scroll-text", action: () => setTab("logs") },
  { id: "action-refresh", label: "Refresh", icon: "refresh-cw", shortcut: "R", action: refresh },
  { id: "action-new-session", label: "New Session", icon: "plus", action: newSession },
  { id: "theme-toggle", label: "Toggle Theme", icon: "sun", action: toggleTheme },
];
```

## Testing
After all changes, run:
```bash
cd ui && pnpm build
```

Build should complete without errors. Test in browser:
1. Toast notifications appear and dismiss correctly
2. Cmd/Ctrl+K opens command palette
3. Animations are smooth
4. Reduced motion is respected
5. All views look consistent
