# MS Teams Provider Research

> Exploratory notes for adding `msteams` as a new provider to Clawdbot.

---

## 1. Existing Provider Structure Analysis

### Directory Structure Pattern

Each provider follows this structure (using Slack as reference):

```
src/slack/
├── index.ts                    # Public exports (barrel file)
├── monitor.ts                  # Main event loop & message handling
├── monitor.test.ts             # Unit tests
├── monitor.tool-result.test.ts # Integration tests
├── send.ts                     # Outbound message delivery
├── actions.ts                  # Platform API actions (reactions, edits, pins)
├── token.ts                    # Token resolution & validation
└── probe.ts                    # Health check / connectivity validation
```

### Key Files by Provider

| Provider | Files |
|----------|-------|
| Telegram | bot.ts, monitor.ts, send.ts, probe.ts, token.ts, webhook.ts, download.ts, draft-stream.ts, pairing-store.ts |
| Discord | monitor.ts, send.ts, probe.ts, token.ts |
| Slack | monitor.ts, send.ts, actions.ts, probe.ts, token.ts |
| Signal | monitor.ts, send.ts, probe.ts (uses signal-cli) |
| iMessage | monitor.ts, send.ts, probe.ts (uses imsg CLI) |

---

## 2. Monitor Pattern (Event Loop)

The `monitorXxxProvider()` function is the heart of each provider. Pattern from Slack:

```typescript
export async function monitorSlackProvider(opts: MonitorSlackOpts = {}) {
  // 1. Load configuration
  const cfg = loadConfig();

  // 2. Resolve tokens (options > env > config)
  const botToken = resolveSlackBotToken(
    opts.botToken ?? process.env.SLACK_BOT_TOKEN ?? cfg.slack?.botToken
  );

  // 3. Create SDK client
  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  // 4. Authenticate and cache identity
  const auth = await app.client.auth.test({ token: botToken });

  // 5. Set up caches (channel info, user info, message dedup)
  const channelCache = new Map<string, ChannelInfo>();
  const userCache = new Map<string, UserInfo>();
  const seenMessages = new Map<string, number>();

  // 6. Register event handlers
  app.event("message", async ({ event }) => {
    await handleMessage(event);
  });

  // 7. Start and wait for abort signal
  await app.start();
  await new Promise<void>((resolve) => {
    opts.abortSignal?.addEventListener("abort", () => resolve());
  });
  await app.stop();
}
```

### Message Processing Pipeline

1. **Validation**: Check message type, ignore bots, dedup check
2. **Channel Resolution**: Get channel metadata (name, type, topic)
3. **Authorization Checks**: DM policy, channel allowlist, user allowlist, mention requirements
4. **Media Download**: Fetch attachments with size limits
5. **Acknowledgment**: Send reaction to confirm receipt
6. **Envelope Construction**: Build `ctxPayload` with all message metadata
7. **System Event Logging**: `enqueueSystemEvent()`
8. **Reply Dispatcher Setup**: Configure typing indicators and threading
9. **Dispatch to Agent**: `dispatchReplyFromConfig()`

---

## 3. Gateway Integration

### Provider Manager (src/gateway/server-providers.ts)

```typescript
// Status types per provider
export type SlackRuntimeStatus = {
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
};

// Combined snapshot
export type ProviderRuntimeSnapshot = {
  whatsapp: WebProviderStatus;
  telegram: TelegramRuntimeStatus;
  discord: DiscordRuntimeStatus;
  slack: SlackRuntimeStatus;
  signal: SignalRuntimeStatus;
  imessage: IMessageRuntimeStatus;
};

// Manager interface
export type ProviderManager = {
  getRuntimeSnapshot: () => ProviderRuntimeSnapshot;
  startProviders: () => Promise<void>;
  startSlackProvider: () => Promise<void>;
  stopSlackProvider: () => Promise<void>;
  // ... per provider
};
```

### Lifecycle Management

```typescript
// State tracking
let slackAbort: AbortController | null = null;
let slackTask: Promise<unknown> | null = null;
let slackRuntime: SlackRuntimeStatus = { running: false };

const startSlackProvider = async () => {
  if (slackTask) return; // Already running

  const cfg = loadConfig();
  if (cfg.slack?.enabled === false) return;

  const botToken = resolveSlackBotToken(...);
  if (!botToken) return; // Not configured

  slackAbort = new AbortController();
  slackRuntime = { running: true, lastStartAt: Date.now() };

  slackTask = monitorSlackProvider({
    botToken,
    runtime: slackRuntimeEnv,
    abortSignal: slackAbort.signal,
  })
    .catch(err => { slackRuntime.lastError = formatError(err); })
    .finally(() => {
      slackAbort = null;
      slackTask = null;
      slackRuntime.running = false;
    });
};
```

### RuntimeEnv Pattern

```typescript
// Minimal interface for provider DI
export type RuntimeEnv = {
  log: typeof console.log;
  error: typeof console.error;
  exit: (code: number) => never;
};

// Created from subsystem logger
const logSlack = logProviders.child("slack");
const slackRuntimeEnv = runtimeForLogger(logSlack);
```

### Config Hot-Reload (src/gateway/config-reload.ts)

```typescript
const RELOAD_RULES: ReloadRule[] = [
  { prefix: "slack", kind: "hot", actions: ["restart-provider:slack"] },
  { prefix: "telegram", kind: "hot", actions: ["restart-provider:telegram"] },
  // ...
];
```

---

## 4. Configuration Types

### Pattern from SlackConfig (src/config/types.ts)

```typescript
export type SlackConfig = {
  enabled?: boolean;                              // Master toggle
  botToken?: string;                              // Primary credential
  appToken?: string;                              // Socket mode credential
  groupPolicy?: GroupPolicy;                      // "open" | "disabled" | "allowlist"
  textChunkLimit?: number;                        // Platform message limit
  mediaMaxMb?: number;                            // File size limit
  dm?: SlackDmConfig;                             // DM-specific settings
  channels?: Record<string, SlackChannelConfig>;  // Per-channel config
  actions?: SlackActionConfig;                    // Feature gating
  slashCommand?: SlackSlashCommandConfig;         // Command config
};

export type SlackDmConfig = {
  enabled?: boolean;
  policy?: DmPolicy;                              // "pairing" | "allowlist" | "open" | "disabled"
  allowFrom?: Array<string | number>;
  groupEnabled?: boolean;
  groupChannels?: Array<string | number>;
};

export type SlackChannelConfig = {
  enabled?: boolean;
  requireMention?: boolean;
  users?: Array<string | number>;                 // Per-channel allowlist
  skills?: string[];                              // Skill filter
  systemPrompt?: string;                          // Channel-specific prompt
};

export type SlackActionConfig = {
  reactions?: boolean;
  messages?: boolean;
  pins?: boolean;
  search?: boolean;
  // ... feature toggles
};
```

### Where Provider Appears in Config

- `ClawdbotConfig.slack` - main config block
- `QueueModeByProvider.slack` - queue mode override
- `AgentElevatedAllowFromConfig.slack` - elevated permissions
- `HookMappingConfig.provider` - webhook routing

---

## 5. Zod Validation Schema

### Pattern (src/config/zod-schema.ts)

```typescript
const SlackConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    botToken: z.string().optional(),
    appToken: z.string().optional(),
    groupPolicy: GroupPolicySchema.optional().default("open"),
    textChunkLimit: z.number().optional(),
    mediaMaxMb: z.number().optional(),
    dm: SlackDmConfigSchema.optional(),
    channels: z.record(z.string(), SlackChannelConfigSchema).optional(),
    actions: SlackActionConfigSchema.optional(),
  })
  .superRefine((value, ctx) => {
    // Cross-field validation
    if (value.dm?.policy === "open" && !value.dm?.allowFrom?.includes("*")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dm", "allowFrom"],
        message: 'slack.dm.policy="open" requires allowFrom to include "*"',
      });
    }
  })
  .optional();
```

---

## 6. Onboarding Flow

### Pattern (src/commands/onboard-providers.ts)

```typescript
// 1. Status detection
const slackConfigured = Boolean(
  process.env.SLACK_BOT_TOKEN || cfg.slack?.botToken
);

// 2. Provider selection
const selection = await prompter.multiselect({
  message: "Select providers",
  options: [
    { value: "slack", label: "Slack", hint: slackConfigured ? "configured" : "needs token" },
  ],
});

// 3. Credential collection
if (selection.includes("slack")) {
  if (process.env.SLACK_BOT_TOKEN && !cfg.slack?.botToken) {
    const useEnv = await prompter.confirm({
      message: "SLACK_BOT_TOKEN detected. Use env var?",
    });
    if (!useEnv) {
      token = await prompter.text({ message: "Enter Slack bot token" });
    }
  }
  // ... also collect app token for socket mode
}

// 4. DM policy configuration
const policy = await selectPolicy({ label: "Slack", provider: "slack" });
cfg = setSlackDmPolicy(cfg, policy);
```

### DM Policy Setter Helper

```typescript
function setSlackDmPolicy(cfg: ClawdbotConfig, dmPolicy: DmPolicy) {
  const dm = cfg.slack?.dm ?? {};
  const allowFrom = dmPolicy === "open"
    ? addWildcardAllowFrom(dm.allowFrom)
    : dm.allowFrom;
  return {
    ...cfg,
    slack: {
      ...cfg.slack,
      dm: { ...dm, policy: dmPolicy, ...(allowFrom ? { allowFrom } : {}) },
    },
  };
}
```

---

## 7. Probe (Health Check)

### Pattern (src/slack/probe.ts)

```typescript
export type SlackProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
  bot?: { id?: string; name?: string };
  team?: { id?: string; name?: string };
};

export async function probeSlack(
  token: string,
  timeoutMs = 2500,
): Promise<SlackProbe> {
  const client = new WebClient(token);
  const start = Date.now();

  try {
    const result = await withTimeout(client.auth.test(), timeoutMs);
    if (!result.ok) {
      return { ok: false, status: 200, error: result.error };
    }
    return {
      ok: true,
      status: 200,
      elapsedMs: Date.now() - start,
      bot: { id: result.user_id, name: result.user },
      team: { id: result.team_id, name: result.team },
    };
  } catch (err) {
    return { ok: false, status: err.status, error: err.message, elapsedMs: Date.now() - start };
  }
}
```

---

## 8. Send Function

### Pattern (src/slack/send.ts)

```typescript
export async function sendMessageSlack(
  to: string,
  message: string,
  opts: SlackSendOpts = {},
): Promise<SlackSendResult> {
  // 1. Parse recipient (user:X, channel:Y, #channel, @user, etc.)
  const recipient = parseRecipient(to);

  // 2. Resolve channel ID (open DM if needed)
  const { channelId } = await resolveChannelId(client, recipient);

  // 3. Chunk text to platform limit
  const chunks = chunkMarkdownText(message, chunkLimit);

  // 4. Upload media if present
  if (opts.mediaUrl) {
    await uploadSlackFile({ client, channelId, mediaUrl, threadTs });
  }

  // 5. Send each chunk
  for (const chunk of chunks) {
    await client.chat.postMessage({
      channel: channelId,
      text: chunk,
      thread_ts: opts.threadTs,
    });
  }

  return { messageId, channelId };
}
```

---

## 9. CLI Integration

### Dependencies (src/cli/deps.ts)

```typescript
export type CliDeps = {
  sendMessageWhatsApp: typeof sendMessageWhatsApp;
  sendMessageTelegram: typeof sendMessageTelegram;
  sendMessageDiscord: typeof sendMessageDiscord;
  sendMessageSlack: typeof sendMessageSlack;
  sendMessageSignal: typeof sendMessageSignal;
  sendMessageIMessage: typeof sendMessageIMessage;
};

export function createDefaultDeps(): CliDeps {
  return {
    sendMessageWhatsApp,
    sendMessageTelegram,
    // ...
  };
}
```

### Send Command (src/commands/send.ts)

```typescript
const provider = (opts.provider ?? "whatsapp").toLowerCase();

// Provider-specific delivery
const results = await deliverOutboundPayloads({
  cfg: loadConfig(),
  provider,
  to: resolvedTarget.to,
  payloads: [{ text: opts.message, mediaUrl: opts.media }],
  deps: {
    sendSlack: deps.sendMessageSlack,
    // ...
  },
});
```

---

## 10. Files to Create/Modify for MS Teams

### New Files (src/msteams/)

```
src/msteams/
├── index.ts           # Exports
├── monitor.ts         # Bot Framework event loop
├── send.ts            # Send via Graph API
├── probe.ts           # Health check (Graph API /me)
├── token.ts           # Token resolution
├── actions.ts         # Optional: reactions, edits, etc.
└── *.test.ts          # Tests
```

### Files to Modify

| File | Changes |
|------|---------|
| `src/config/types.ts` | Add `MSTeamsConfig`, update `QueueModeByProvider`, `AgentElevatedAllowFromConfig`, `HookMappingConfig` |
| `src/config/zod-schema.ts` | Add `MSTeamsConfigSchema` |
| `src/gateway/server-providers.ts` | Add `MSTeamsRuntimeStatus`, lifecycle methods, update `ProviderRuntimeSnapshot`, `ProviderManager` |
| `src/gateway/server.ts` | Add logger, runtimeEnv, pass to provider manager |
| `src/gateway/config-reload.ts` | Add reload rule |
| `src/gateway/server-methods/providers.ts` | Add status endpoint |
| `src/cli/deps.ts` | Add `sendMessageMSTeams` |
| `src/cli/program.ts` | Add to `--provider` options |
| `src/commands/send.ts` | Add msteams case |
| `src/commands/onboard-providers.ts` | Add wizard flow |
| `src/commands/onboard-types.ts` | Add to `ProviderChoice` |
| `docs/providers/msteams.md` | Documentation |

---

## 11. MS Teams SDK Options

### Option A: Bot Framework SDK (@microsoft/botframework)

```typescript
import { CloudAdapter, ConfigurationBotFrameworkAuthentication } from "botbuilder";

// Pros: Full-featured, handles auth, typing indicators, cards
// Cons: More complex, requires Azure Bot registration
```

### Option B: Microsoft Graph API

```typescript
import { Client } from "@microsoft/microsoft-graph-client";

// Pros: Simpler for basic messaging, direct API access
// Cons: Less rich features, manual auth handling
```

### Recommended: Bot Framework for receiving, Graph for some sends

MS Teams bots use the Bot Framework for receiving messages (webhook-based), and can use either Bot Framework or Graph API for sending.

### Required Azure Resources

1. **Azure Bot Registration** - Bot identity and channel configuration
2. **App Registration** - OAuth for Graph API access
3. **Teams App Manifest** - Defines bot capabilities in Teams

### Credentials Needed

```typescript
export type MSTeamsConfig = {
  enabled?: boolean;
  appId?: string;           // Azure AD App ID
  appPassword?: string;     // Azure AD App Secret
  tenantId?: string;        // Optional: restrict to tenant
  // ... rest follows pattern
};
```

---

## 12. Key Differences from Slack

| Aspect | Slack | MS Teams |
|--------|-------|----------|
| Connection | Socket Mode (WebSocket) | Webhook (HTTP POST) |
| Auth | Bot Token + App Token | Azure AD App ID + Secret |
| Message ID | `ts` (timestamp) | Activity ID |
| Threading | `thread_ts` | `replyToId` in conversation |
| Channels | Channel ID | Channel ID + Team ID |
| DMs | `conversations.open` | Proactive messaging with conversation reference |
| Typing | `assistant.threads.setStatus` | `sendTypingActivity()` |
| Reactions | `reactions.add` | Separate message with reaction |
| Media | `files.uploadV2` | Attachments in activity |

---

## 13. Implementation Considerations

### Webhook vs Polling

MS Teams uses webhooks exclusively (no polling option like Telegram). Need to:
- Expose HTTP endpoint for Bot Framework
- Handle activity validation (HMAC signature)
- Consider tunneling for local dev (ngrok, Tailscale funnel)

### Proactive Messaging

Unlike Slack where you can message any user, Teams requires:
- User must have interacted with bot first, OR
- Bot must be installed in team/chat, OR
- Use Graph API with appropriate permissions

### Tenant Restrictions

Enterprise Teams often restrict:
- External app installations
- Cross-tenant communication
- Certain API permissions

Config should support `tenantId` restriction.

### Cards and Adaptive Cards

Teams heavily uses Adaptive Cards for rich UI. Consider supporting:
- Basic text (markdown subset)
- Adaptive Card JSON
- Hero Cards for media

---

## Next Steps

1. **Research**: MS Teams Bot Framework SDK specifics
2. **Azure Setup**: Document bot registration process
3. **Implement**: Start with monitor.ts and basic send
4. **Test**: Local dev with ngrok/tunnel
5. **Docs**: Provider setup guide
