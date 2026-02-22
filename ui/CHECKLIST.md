# UI Dashboard — Verification Checklist

Run through this checklist after every change that touches `ui/` files.
Open the dashboard at `http://localhost:<port>` (or the gateway's configured UI URL).

## Login & Shell

- [ ] Login gate renders when not authenticated
- [ ] Login with valid password grants access
- [ ] Login with invalid password shows error
- [ ] App shell loads: sidebar, header, content area visible
- [ ] Sidebar shows all tab groups: Chat, Control, Agent, Settings
- [ ] Sidebar collapse/expand works; favicon logo shows when collapsed
- [ ] Router: clicking each sidebar tab navigates and updates URL
- [ ] Browser back/forward navigates between tabs
- [ ] Direct URL navigation (e.g. `/chat`, `/overview`) loads correct tab

## Themes

- [ ] Theme switcher cycles through all 5 themes:
  - [ ] Dark (Obsidian)
  - [ ] Light
  - [ ] OpenKnot (Aurora)
  - [ ] Field Manual
  - [ ] OpenClaw (Chrome)
- [ ] Glass components (cards, panels, inputs) render correctly per theme
- [ ] Theme persists across page reload

## Overview

- [ ] Overview tab loads without errors
- [ ] Stat cards render: cost, sessions, skills, cron
- [ ] Cards show accent color borders per kind
- [ ] Cards show hover lift + shadow effect
- [ ] Cards are clickable and navigate to corresponding tab
- [ ] Responsive grid: 4 columns → 2 → 1 at breakpoints
- [ ] Attention items render with correct severity icons/colors (error, warning, info)
- [ ] Event log renders with timestamps
- [ ] Log tail section renders live gateway log lines
- [ ] Quick actions section renders
- [ ] Redact toggle in topbar redacts/reveals sensitive values in cards

## Chat

- [ ] Chat view renders message history
- [ ] Sending a message works and response streams in
- [ ] Markdown rendering works in responses (code blocks, lists, links)
- [ ] Tool call cards render collapsed by default
- [ ] Tool cards expand/collapse on click; summary shows tool name/count
- [ ] JSON messages render collapsed by default
- [ ] Delete message: trash icon appears on hover, click removes message group
- [ ] Deleted messages persist across reload (localStorage)
- [ ] Clear history button resets session via `sessions.reset` RPC
- [ ] Agent selector dropdown appears when multiple agents configured
- [ ] Switching agents updates session key and reloads history
- [ ] Session list panel: shows all sessions for current agent
- [ ] Session list: clicking a session switches to it
- [ ] Input history (up/down arrow) recalls previous messages
- [ ] Slash command menu opens on `/` keystroke
- [ ] Slash commands show icons, categories, and grouping
- [ ] Pinned messages render if present

## Command Palette

- [ ] Opens via keyboard shortcut or UI button
- [ ] Fuzzy search filters commands as you type
- [ ] Results grouped by category with labels
- [ ] Selecting a command executes it
- [ ] "No results" message when nothing matches
- [ ] Clicking overlay closes palette
- [ ] Escape key closes palette

## Agents

- [ ] Agent tab loads agent list
- [ ] Agent overview panel: identity card with name, ID, avatar color
- [ ] Agent config display: model, tools, skills shown
- [ ] Agent panels: overview, status/files, tools/skills tabs work
- [ ] Tab counts show for files, skills, channels, cron
- [ ] Sidebar agent filter input filters agents in multi-agent setup
- [ ] Agent actions menu: "copy ID" and "set as default" work
- [ ] Chip-based fallback input (model selection): Enter/comma adds chips

## Channels & Instances

- [ ] Channels tab lists connected channels
- [ ] Instances tab lists connected instances
- [ ] Host/IP blurred by default in Connected Instances
- [ ] Reveal toggle shows actual host/IP values
- [ ] Nostr profile form renders if nostr channel present

## Privacy & Redaction

- [ ] Topbar redact toggle visible; default is stream mode on
- [ ] Redact ON: sensitive values masked in overview cards
- [ ] Redact ON: cost digits blurred
- [ ] Redact ON: access card blurred
- [ ] Redact ON: raw config JSON masks sensitive values with count badge
- [ ] Redact OFF: all values visible

## Config

- [ ] Config tab renders current gateway configuration
- [ ] Config form fields editable
- [ ] Sensitive config values masked when redact is on
- [ ] Config analysis view loads

## Other Tabs

- [ ] Sessions tab loads session list
- [ ] Usage tab loads usage statistics with styled sections
- [ ] Cron tab lists cron jobs with status
- [ ] Skills tab lists skills with status report
- [ ] Nodes tab loads
- [ ] Debug tab renders debug info
- [ ] Logs tab renders

## i18n

- [ ] English locale loads by default
- [ ] All visible strings use i18n keys (no hardcoded English in templates)
- [ ] zh-CN locale keys present
- [ ] zh-TW locale keys present
- [ ] pt-BR locale keys present

## Responsive & Mobile

- [ ] Sidebar collapses on narrow viewport
- [ ] Bottom tabs render on mobile breakpoint
- [ ] Card grid reflows: 4 → 2 → 1 columns
- [ ] Chat input usable on mobile
- [ ] No horizontal overflow on any tab at 375px width

## Build & Tests

- [ ] `pnpm build` completes without errors
- [ ] `pnpm test` passes — specifically `ui/` test files:
  - [ ] `app-gateway.node.test.ts`
  - [ ] `app-settings.test.ts`
  - [ ] `config-form.browser.test.ts`
  - [ ] `config.browser.test.ts`
  - [ ] `chat.test.ts`
- [ ] No new TypeScript errors: `pnpm tsgo`
- [ ] No lint/format issues: `pnpm check`
