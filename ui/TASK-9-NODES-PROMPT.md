# Task 9: Redesign Nodes View with Visual Hierarchy

## Overview
Redesign the nodes view (`ui/src/ui/views/nodes.ts`) with better visual hierarchy, node cards with status indicators, and improved device/exec approval management.

## Project Context

### Tech Stack
- **Framework**: Lit (Web Components) - NOT React
- **Styling**: Tailwind CSS v4 with CSS-first configuration
- **Build**: Vite
- **Icons**: Custom SVG icon system in `ui/src/ui/icons.ts`

### Key Files
- View to modify: `ui/src/ui/views/nodes.ts`
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
--border-strong: rgba(255, 255, 255, 0.16);
--accent: #f59f4a;
--accent-2: #34c7b7;
--ok: #2bd97f;
--warn: #f2c94c;
--danger: #ff6b6b;
```

### Icon System Usage
```typescript
import { icon } from "../icons";

// In template:
${icon("server", { size: 20 })}
${icon("check", { size: 16 })}
${icon("alert-triangle", { size: 16 })}
```

Available icons: `message-square`, `layout-dashboard`, `link`, `radio`, `file-text`, `clock`, `zap`, `server`, `settings`, `bug`, `scroll-text`, `book-open`, `chevron-down`, `chevron-right`, `chevron-left`, `menu`, `x`, `sun`, `moon`, `monitor`, `refresh-cw`, `maximize`, `brain`, `sparkles`, `user`, `log-out`, `check`, `alert-circle`, `info`, `alert-triangle`, `plus`, `minus`, `search`, `filter`, `more-vertical`, `edit`, `trash`, `copy`, `external-link`, `play`, `pause`, `stop`, `send`, `panel-left`

## Design Requirements

### Visual Style
1. **Node cards** - Each node as a distinct card with status
2. **Visual hierarchy** - Gateway at top, nodes below
3. **Status indicators** - Online/offline/pending states
4. **Connection lines** - Optional visual connections between nodes
5. **Device management** - Clear device pairing interface
6. **Exec approvals** - Approval request management

### Nodes View Specific Requirements
1. **Node overview** - List of connected nodes with status
2. **Node details** - Expandable details for each node
3. **Device pairing** - Pending requests, approved devices
4. **Exec approvals** - Per-node or gateway-level approvals
5. **Bindings** - Default and per-agent node bindings
6. **Actions** - Approve, reject, rotate, revoke tokens

### Suggested Layout
```
┌─────────────────────────────────────────────────┐
│ Nodes Header (title, refresh)                   │
├─────────────────────────────────────────────────┤
│ [Nodes] [Devices] [Exec Approvals]              │
├─────────────────────────────────────────────────┤
│                                                 │
│  Nodes Tab:                                     │
│  ┌─────────────────────────────────────────┐   │
│  │        ┌─────────────┐                  │   │
│  │        │  Gateway    │                  │   │
│  │        │  ● Online   │                  │   │
│  │        └──────┬──────┘                  │   │
│  │               │                         │   │
│  │     ┌─────────┼─────────┐               │   │
│  │     │         │         │               │   │
│  │ ┌───┴───┐ ┌───┴───┐ ┌───┴───┐          │   │
│  │ │Node 1 │ │Node 2 │ │Node 3 │          │   │
│  │ │●Online│ │○Offline│ │●Online│          │   │
│  │ └───────┘ └───────┘ └───────┘          │   │
│  └─────────────────────────────────────────┘   │
│                                                 │
└─────────────────────────────────────────────────┘
```

### Devices Tab Layout
```
┌─────────────────────────────────────────────────┐
│ Pending Requests                                │
├─────────────────────────────────────────────────┤
│ ┌───────────────────────────────────────────┐  │
│ │ Device: MacBook Pro                       │  │
│ │ Request ID: abc123...                     │  │
│ │ [Approve] [Reject]                        │  │
│ └───────────────────────────────────────────┘  │
├─────────────────────────────────────────────────┤
│ Approved Devices                                │
├─────────────────────────────────────────────────┤
│ ┌───────────────────────────────────────────┐  │
│ │ Device: iPhone                      ● Active│  │
│ │ Role: user │ Scopes: chat,config           │  │
│ │ [Rotate Token] [Revoke]                    │  │
│ └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

## CSS Classes to Add (append to components.css)

```css
/* Nodes View Styles */
.nodes-container { /* main container */ }
.nodes-tabs { /* tab navigation */ }
.nodes-tab { /* individual tab */ }
.nodes-tab--active { /* active tab */ }
.nodes-content { /* tab content area */ }

/* Node Tree Visualization */
.node-tree { /* tree container */ }
.node-tree__gateway { /* gateway node (root) */ }
.node-tree__branches { /* branch lines container */ }
.node-tree__children { /* child nodes container */ }

/* Node Card */
.node-card { /* individual node card */ }
.node-card--online { /* online state */ }
.node-card--offline { /* offline state */ }
.node-card--pending { /* pending state */ }
.node-card__header { /* card header */ }
.node-card__icon { /* node icon */ }
.node-card__name { /* node name */ }
.node-card__status { /* status indicator */ }
.node-card__details { /* expandable details */ }
.node-card__meta { /* metadata rows */ }
.node-card__actions { /* action buttons */ }

/* Status Dot */
.status-dot { /* base dot */ }
.status-dot--online { /* green */ }
.status-dot--offline { /* gray */ }
.status-dot--pending { /* yellow pulse */ }

/* Devices Section */
.devices-section { /* section container */ }
.devices-section__title { /* section title */ }
.devices-list { /* device list */ }

.device-card { /* device card */ }
.device-card--pending { /* pending request */ }
.device-card--active { /* active device */ }
.device-card__header { /* card header */ }
.device-card__icon { /* device icon */ }
.device-card__name { /* device name */ }
.device-card__status { /* status badge */ }
.device-card__meta { /* metadata */ }
.device-card__actions { /* action buttons */ }

/* Pending Request */
.pending-request { /* pending request card */ }
.pending-request__id { /* request ID */ }
.pending-request__actions { /* approve/reject buttons */ }

/* Exec Approvals */
.exec-approvals { /* approvals container */ }
.exec-approvals__target { /* target selector */ }
.exec-approvals__form { /* approval form */ }
.exec-approvals__agent { /* agent selector */ }
.exec-approvals__rules { /* rules list */ }

/* Bindings Section */
.bindings-section { /* bindings container */ }
.binding-row { /* binding row */ }
.binding-row__label { /* binding label */ }
.binding-row__value { /* binding value/selector */ }
```

## Implementation Steps

1. **Read current nodes.ts** - Understand existing structure and props
2. **Add icon import** - `import { icon } from "../icons";`
3. **Create tab navigation** - Nodes, Devices, Exec Approvals tabs
4. **Build node cards** - Visual cards with status indicators
5. **Add node tree layout** - Visual hierarchy (optional)
6. **Build devices section** - Pending requests and approved devices
7. **Style action buttons** - Approve, reject, rotate, revoke
8. **Build exec approvals** - Target selection, rules form
9. **Add CSS to components.css** - Nodes view styles
10. **Test build** - Run `pnpm build` to verify no errors

## Example Node Card Pattern

```typescript
html`
  <div class="node-card node-card--${node.online ? "online" : "offline"}">
    <div class="node-card__header">
      <div class="node-card__icon">
        ${icon("server", { size: 20 })}
      </div>
      <div class="node-card__name">${node.id}</div>
      <div class="node-card__status">
        <span class="status-dot status-dot--${node.online ? "online" : "offline"}"></span>
        <span>${node.online ? "Online" : "Offline"}</span>
      </div>
    </div>
    <div class="node-card__details">
      <div class="node-card__meta">
        <span class="muted">Last seen:</span>
        <span>${formatAgo(node.lastSeen)}</span>
      </div>
      <div class="node-card__meta">
        <span class="muted">Version:</span>
        <span>${node.version}</span>
      </div>
    </div>
    <div class="node-card__actions">
      <button class="btn btn--sm" @click=${() => onBindDefault(node.id)}>
        ${icon("link", { size: 14 })}
        <span>Set Default</span>
      </button>
    </div>
  </div>
`
```

## Example Device Card Pattern

```typescript
html`
  <div class="device-card device-card--${device.pending ? "pending" : "active"}">
    <div class="device-card__header">
      <div class="device-card__icon">
        ${icon("monitor", { size: 18 })}
      </div>
      <div class="device-card__name">${device.name || device.deviceId}</div>
      <span class="badge badge--${device.pending ? "warn" : "ok"}">
        ${device.pending ? "Pending" : "Active"}
      </span>
    </div>
    ${device.pending ? html`
      <div class="pending-request__actions">
        <button class="btn btn--primary btn--sm" @click=${() => onApprove(device.requestId)}>
          ${icon("check", { size: 14 })}
          <span>Approve</span>
        </button>
        <button class="btn btn--danger btn--sm" @click=${() => onReject(device.requestId)}>
          ${icon("x", { size: 14 })}
          <span>Reject</span>
        </button>
      </div>
    ` : html`
      <div class="device-card__meta">
        <span class="muted">Role:</span> ${device.role}
        <span class="muted">Scopes:</span> ${device.scopes?.join(", ")}
      </div>
      <div class="device-card__actions">
        <button class="btn btn--sm" @click=${() => onRotate(device.deviceId)}>
          ${icon("refresh-cw", { size: 14 })}
          <span>Rotate</span>
        </button>
        <button class="btn btn--danger btn--sm" @click=${() => onRevoke(device.deviceId)}>
          ${icon("trash", { size: 14 })}
          <span>Revoke</span>
        </button>
      </div>
    `}
  </div>
`
```

## Testing
After changes, run:
```bash
cd ui && pnpm build
```

Build should complete without errors.
