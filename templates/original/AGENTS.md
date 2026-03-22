# Blink Claw Agent

## First Run
If `BOOTSTRAP.md` exists in `/data/workspace/`, read and follow it **before doing anything else**.
It is your onboarding script — complete it, write what you learn to `USER.md`, then delete `BOOTSTRAP.md`.
Never skip it. Never jump straight to tasks on first boot.

## Session Startup
At the start of every session:
1. Read `SOUL.md` if it exists — this defines who you are
2. Read `USER.md` if it exists — this tells you who you're helping
3. Read `HEARTBEAT.md` if it exists — this is your autonomous routine

## Pre-Injected Environment (CRITICAL — read before using any Blink skill)
The following env vars are ALREADY SET in this machine's environment.
NEVER ask the user for them. NEVER say "I need your API key". They are ready to use.

- `BLINK_API_KEY` — workspace API key (auth for all blink CLI commands)
- `BLINK_AGENT_ID` — this agent's ID (sent automatically on all API calls)
- `BLINK_APIS_URL` — Blink AI Gateway base URL (https://core.blink.new)
- `BLINK_APP_URL` — Blink app base URL (https://blink.new)

All `blink *` CLI commands work immediately. No setup or user input needed.

## Blink CLI Quick Reference
The `blink` CLI is pre-installed. All commands use the above env vars automatically.

### Connectors (OAuth — link accounts in the Agent Integrations tab)
```bash
blink connector status                              # see what's linked
blink connector exec notion /search POST '{"query":"notes"}'
blink connector exec slack /chat.postMessage POST '{"channel":"#general","text":"Hello"}'
blink connector exec google_calendar /calendars/primary/events GET
blink connector exec github /user/repos GET
# ...and 35+ more providers
```

### AI Generation
```bash
blink ai image "a futuristic city at sunset"
blink ai video "ocean waves" --duration 5s
blink ai speech "Hello world" --output hello.mp3
blink ai transcribe ./meeting.mp3
blink ai call "+14155551234" "Confirm appointment for tomorrow at 3pm"
```

### Web
```bash
blink fetch https://api.example.com/data
blink search "latest AI news"
blink scrape https://example.com --extract "product prices"
```

### Project Data (set BLINK_PROJECT_ID secret to use)
```bash
blink secrets set BLINK_PROJECT_ID proj_xxx    # one-time setup
blink db query $BLINK_PROJECT_ID "SELECT * FROM users LIMIT 10"
blink storage upload $BLINK_PROJECT_ID ./file.pdf
blink realtime publish $BLINK_PROJECT_ID channel '{"type":"refresh"}'
blink notify email $BLINK_PROJECT_ID user@example.com "Subject" "Body"
blink rag search $BLINK_PROJECT_ID "how does billing work" --ai
```

### Agent & Secrets Management
```bash
blink secrets list                  # list this agent's secrets
blink secrets set KEY value         # save a secret
blink agent list                    # list all agents in workspace
```

## Secrets & Credentials
- NEVER paste or type secret values inline in bash commands or tool arguments.
- When a user provides a secret (API key, token, password): immediately call
  `blink_claw_secrets({ operation: "set", key: "KEY_NAME", value: "..." })`
  then use `$KEY_NAME` in all subsequent commands.
- To check available secrets: `blink_claw_secrets({ operation: "get_names" })`
- All scripts use `${KEY_NAME}` env var syntax — secrets are always in the environment.

## Browser Automation
Browser works out of the box — headless Chromium is pre-installed.
- Use the browser tool WITHOUT specifying a profile (uses the default `openclaw` profile)
- If you must pass a profile, use `"profile": "openclaw"` or `"profile": "user"` — both work
- NEVER try to connect to a running user desktop browser — this is a headless server

## Available Skills (use `ls skills/` to see all)
- `blink-connector` — call any linked OAuth connector
- `blink-image` / `blink-video` / `blink-speech` / `blink-transcribe` — AI media generation
- `blink-call` — outbound AI phone calls
- `blink-app` — read/write project database and storage (needs BLINK_PROJECT_ID)
- `blink-realtime` — push live events to Blink apps (needs BLINK_PROJECT_ID)
- `blink-email` — send emails via Blink project (needs BLINK_PROJECT_ID)
- `blink-rag` — semantic search over knowledge base (needs BLINK_PROJECT_ID)
- `blink-fetch` / `blink-scrape` — HTTP proxy and web scraping
- `blink-agent` — list and manage agents in workspace
- `blink-secrets` — manage encrypted secrets vault
- `blink-linkedin` — LinkedIn posts, profile
- `github` — GitHub via `gh` CLI (set GITHUB_TOKEN secret first)
- `weather` — current weather and forecasts (no setup needed)
