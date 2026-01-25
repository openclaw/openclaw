# Task 3: Redesign Chat View with Modern AI Chat Patterns

## Overview
Redesign the chat view (`ui/src/ui/views/chat.ts` and related files) with modern AI chat patterns, better message styling, and improved composition UX.

## Project Context

### Tech Stack
- **Framework**: Lit (Web Components) - NOT React
- **Styling**: Tailwind CSS v4 with CSS-first configuration
- **Build**: Vite
- **Icons**: Custom SVG icon system in `ui/src/ui/icons.ts`

### Key Files
- Main view: `ui/src/ui/views/chat.ts`
- Chat styles: `ui/src/styles/chat.css`
- Message rendering: `ui/src/ui/chat/grouped-render.ts`
- Message normalizer: `ui/src/ui/chat/message-normalizer.ts`
- Markdown sidebar: `ui/src/ui/views/markdown-sidebar.ts`
- General styles: `ui/src/styles/components.css`
- Icons: `ui/src/ui/icons.ts`

## Design System Reference

### CSS Variables (from base.css)
```css
/* Dark theme */
--bg: #0a0f14;
--panel: rgba(14, 20, 30, 0.88);
--panel-rgb: 14, 20, 30;
--text: rgba(244, 246, 251, 0.96);
--chat-text: rgba(231, 237, 244, 0.92);
--muted: rgba(156, 169, 189, 0.72);
--border: rgba(255, 255, 255, 0.09);
--accent: #f59f4a;
--accent-2: #34c7b7;
--ok: #2bd97f;
--warn: #f2c94c;
--danger: #ff6b6b;
```

### Icon System Usage
```typescript
import { icon } from "../icons";

${icon("send", { size: 18 })}
${icon("refresh-cw", { size: 16 })}
${icon("user", { size: 20 })}
```

Available icons: `message-square`, `layout-dashboard`, `link`, `radio`, `file-text`, `clock`, `zap`, `server`, `settings`, `bug`, `scroll-text`, `book-open`, `chevron-down`, `chevron-right`, `chevron-left`, `menu`, `x`, `sun`, `moon`, `monitor`, `refresh-cw`, `maximize`, `brain`, `sparkles`, `user`, `log-out`, `check`, `alert-circle`, `info`, `alert-triangle`, `plus`, `minus`, `search`, `filter`, `more-vertical`, `edit`, `trash`, `copy`, `external-link`, `play`, `pause`, `stop`, `send`, `panel-left`

## Design Requirements

### Visual Style - Modern AI Chat
1. **Message bubbles** - Distinct user vs assistant styling
2. **Avatar indicators** - User icon, assistant avatar/icon
3. **Typing indicator** - Animated dots during streaming
4. **Code blocks** - Syntax highlighted with copy button
5. **Tool calls** - Collapsible tool execution display
6. **Timestamps** - Subtle, relative timestamps
7. **Smooth scrolling** - Auto-scroll to new messages

### Chat View Specific Requirements
1. **Message thread** - Scrollable message history
2. **Message groups** - Group consecutive messages from same sender
3. **Streaming display** - Real-time token display during generation
4. **Thinking/reasoning** - Collapsible reasoning display
5. **Tool outputs** - Expandable tool results
6. **Composition area** - Multi-line input with send button
7. **Session controls** - Session selector, new session, refresh
8. **Focus mode** - Hide sidebar for distraction-free chat
9. **Queue display** - Show queued messages during processing
10. **Abort button** - Cancel ongoing generation

### Suggested Layout
```
┌─────────────────────────────────────────────────┐
│ Chat Header (session selector, controls)        │
├─────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────┐ │
│ │ Message Thread                              │ │
│ │                                             │ │
│ │ ┌─────────────────────────────────────────┐ │ │
│ │ │ 👤 User                                 │ │ │
│ │ │ How do I configure webhooks?            │ │ │
│ │ └─────────────────────────────────────────┘ │ │
│ │                                             │ │
│ │ ┌─────────────────────────────────────────┐ │ │
│ │ │ 🤖 Assistant                      2m ago │ │ │
│ │ │ To configure webhooks, you need to...   │ │ │
│ │ │                                         │ │ │
│ │ │ ```bash                                 │ │ │
│ │ │ clawdbot config set webhooks.url...     │ │ │
│ │ │ ```                          [Copy]     │ │ │
│ │ │                                         │ │ │
│ │ │ ▼ Tool: config.get              [View]  │ │ │
│ │ └─────────────────────────────────────────┘ │ │
│ │                                             │ │
│ │ ● ● ● (typing indicator)                   │ │
│ └─────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────┐ │
│ │ Type a message...                    [Send] │ │
│ └─────────────────────────────────────────────┘ │
│ Queue: 2 messages pending                       │
└─────────────────────────────────────────────────┘
```

### Message Bubble Patterns

#### User Message
```
┌─────────────────────────────────────────────────┐
│                              ┌────────────────┐ │
│                              │ User message   │ │
│                              │ content here   │ │
│                              └────────────────┘ │
│                                          👤 You │
└─────────────────────────────────────────────────┘
```

#### Assistant Message
```
┌─────────────────────────────────────────────────┐
│ 🤖 Assistant                              2m ago│
│ ┌─────────────────────────────────────────────┐ │
│ │ Assistant message content here              │ │
│ │                                             │ │
│ │ With markdown support, code blocks, etc.   │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ ▼ Thinking (click to expand)                   │
│ ▼ Tool: read_file                    [View]    │
└─────────────────────────────────────────────────┘
```

## CSS Classes to Add/Update (in chat.css or components.css)

```css
/* Chat Layout */
.chat-container { /* main chat container */ }
.chat-thread { /* scrollable message area */ }
.chat-compose { /* composition area */ }

/* Message Groups */
.message-group { /* group of messages from same sender */ }
.message-group--user { /* user message group */ }
.message-group--assistant { /* assistant message group */ }

/* Message Bubble */
.message-bubble { /* individual message */ }
.message-bubble--user { /* user styling */ }
.message-bubble--assistant { /* assistant styling */ }
.message-bubble__header { /* sender + timestamp */ }
.message-bubble__avatar { /* avatar icon/image */ }
.message-bubble__sender { /* sender name */ }
.message-bubble__time { /* timestamp */ }
.message-bubble__content { /* message content */ }
.message-bubble__actions { /* copy, etc. */ }

/* Code Blocks */
.code-block { /* code block container */ }
.code-block__header { /* language + copy button */ }
.code-block__content { /* code content */ }
.code-block__copy { /* copy button */ }

/* Tool Calls */
.tool-call { /* tool call container */ }
.tool-call--collapsed { /* collapsed state */ }
.tool-call--expanded { /* expanded state */ }
.tool-call__header { /* tool name + toggle */ }
.tool-call__icon { /* tool icon */ }
.tool-call__name { /* tool name */ }
.tool-call__toggle { /* expand/collapse */ }
.tool-call__content { /* tool input/output */ }
.tool-call__view { /* view output button */ }

/* Thinking/Reasoning */
.thinking-block { /* thinking container */ }
.thinking-block__header { /* toggle header */ }
.thinking-block__content { /* thinking content */ }

/* Typing Indicator */
.typing-indicator { /* indicator container */ }
.typing-indicator__dot { /* animated dot */ }

/* Composition Area */
.chat-compose { /* compose container */ }
.chat-compose__input { /* textarea */ }
.chat-compose__actions { /* send/abort buttons */ }
.chat-compose__send { /* send button */ }
.chat-compose__abort { /* abort button */ }

/* Queue Display */
.chat-queue { /* queue container */ }
.chat-queue__item { /* queued message */ }
.chat-queue__remove { /* remove button */ }

/* Streaming */
.streaming-message { /* streaming state */ }
.streaming-cursor { /* blinking cursor */ }

/* Focus Mode */
.chat-container--focus { /* focus mode styles */ }
```

### Chat Bubble Styling
```css
.message-bubble--user {
  margin-left: auto;
  max-width: 80%;
  background: linear-gradient(135deg, rgba(245, 159, 74, 0.15), rgba(245, 159, 74, 0.08));
  border: 1px solid rgba(245, 159, 74, 0.25);
  border-radius: 16px 16px 4px 16px;
}

.message-bubble--assistant {
  max-width: 90%;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.02));
  border: 1px solid var(--border);
  border-radius: 16px 16px 16px 4px;
}

.message-bubble__avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.08);
  color: var(--muted);
  flex-shrink: 0;
}

.message-bubble--user .message-bubble__avatar {
  background: rgba(245, 159, 74, 0.2);
  color: var(--accent);
}

/* Typing indicator animation */
.typing-indicator {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 12px 16px;
}

.typing-indicator__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
  animation: typingBounce 1.4s ease-in-out infinite;
}

.typing-indicator__dot:nth-child(1) { animation-delay: 0ms; }
.typing-indicator__dot:nth-child(2) { animation-delay: 200ms; }
.typing-indicator__dot:nth-child(3) { animation-delay: 400ms; }

@keyframes typingBounce {
  0%, 60%, 100% { transform: translateY(0); }
  30% { transform: translateY(-8px); }
}

/* Streaming cursor */
.streaming-cursor::after {
  content: "▊";
  animation: blink 1s step-end infinite;
  color: var(--accent);
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
```

### Compose Area Styling
```css
.chat-compose {
  padding: 16px;
  border-top: 1px solid var(--border);
  background: var(--panel);
}

.chat-compose__input {
  width: 100%;
  min-height: 48px;
  max-height: 200px;
  padding: 14px 16px;
  border: 1px solid var(--border-strong);
  border-radius: 16px;
  background: rgba(0, 0, 0, 0.2);
  color: var(--chat-text);
  font-size: 14px;
  line-height: 1.5;
  resize: none;
  outline: none;
  transition: border-color 180ms ease, box-shadow 180ms ease;
}

.chat-compose__input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--focus);
}

.chat-compose__actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}

.chat-compose__send {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  border-radius: 12px;
  background: linear-gradient(135deg, var(--accent), rgba(245, 159, 74, 0.8));
  border: none;
  color: #000;
  font-weight: 600;
  cursor: pointer;
  transition: transform 150ms ease, box-shadow 150ms ease;
}

.chat-compose__send:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(245, 159, 74, 0.4);
}

.chat-compose__send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.chat-compose__abort {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: 12px;
  background: rgba(255, 107, 107, 0.15);
  border: 1px solid rgba(255, 107, 107, 0.3);
  color: var(--danger);
  cursor: pointer;
  transition: background 150ms ease, border-color 150ms ease;
}

.chat-compose__abort:hover {
  background: rgba(255, 107, 107, 0.25);
  border-color: rgba(255, 107, 107, 0.5);
}
```

## Implementation Steps

1. **Read current chat.ts** - Understand existing structure and props
2. **Read chat.css** - Understand existing styles
3. **Read grouped-render.ts** - Understand message rendering
4. **Add icon imports** - Import `icon` function
5. **Update message rendering** - Apply new bubble patterns
6. **Improve code blocks** - Add copy button, better styling
7. **Style tool calls** - Collapsible with view button
8. **Add typing indicator** - Animated dots during streaming
9. **Update compose area** - Better input styling, send/abort buttons
10. **Add queue display** - Show pending messages
11. **Update CSS** - Append new styles to chat.css
12. **Test build** - Run `pnpm build`

## Example Message Group Pattern

```typescript
html`
  <div class="message-group message-group--${role}">
    <div class="message-group__header">
      <div class="message-bubble__avatar">
        ${role === "user"
          ? icon("user", { size: 18 })
          : assistantAvatar
            ? html`<img src=${assistantAvatar} alt="" />`
            : icon("sparkles", { size: 18 })}
      </div>
      <span class="message-bubble__sender">
        ${role === "user" ? "You" : assistantName}
      </span>
      <span class="message-bubble__time">${formatAgo(timestamp)}</span>
    </div>
    <div class="message-group__messages">
      ${messages.map(msg => renderMessageBubble(msg, role))}
    </div>
  </div>
`
```

## Example Compose Area Pattern

```typescript
html`
  <div class="chat-compose">
    <textarea
      class="chat-compose__input"
      placeholder=${placeholder}
      .value=${draft}
      ?disabled=${!canCompose}
      @input=${(e: Event) => onDraftChange((e.target as HTMLTextAreaElement).value)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onSend();
        }
      }}
    ></textarea>
    <div class="chat-compose__actions">
      ${isBusy && canAbort
        ? html`
            <button class="chat-compose__abort" @click=${onAbort}>
              ${icon("stop", { size: 16 })}
              <span>Stop</span>
            </button>
          `
        : html`
            <button
              class="chat-compose__send"
              ?disabled=${!canSend || !draft.trim()}
              @click=${onSend}
            >
              ${icon("send", { size: 16 })}
              <span>Send</span>
            </button>
          `}
      <button class="btn btn--secondary" @click=${onNewSession} title="New session">
        ${icon("plus", { size: 16 })}
        <span>New</span>
      </button>
    </div>
  </div>
`
```

## Testing
After changes, run:
```bash
cd ui && pnpm build
```

Build should complete without errors. Test in browser:
1. Messages display correctly with bubbles
2. User vs assistant styling is distinct
3. Typing indicator shows during streaming
4. Code blocks have copy functionality
5. Tool calls are collapsible
6. Send button works, abort button appears during generation
7. Focus mode hides sidebar
