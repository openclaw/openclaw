/**
 * Controller for the Console views.
 * Fetches run traces, prompt snapshots, and security info from the gateway.
 * Falls back to demo data when the gateway doesn't support these endpoints yet.
 */

import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  RunTrace,
  RunListEntry,
  PromptSnapshot,
  SecuritySnapshot,
  SessionDetail,
  TraceNode,
  TraceEdge,
} from "../types/console-types.ts";

// ─── State shape ────────────────────────────────────────────────

export type ConsoleState = {
  // Run trace
  traceLoading: boolean;
  traceError: string | null;
  traceRunList: RunListEntry[];
  traceSelectedRunId: string | null;
  traceActiveRun: RunTrace | null;
  traceSubagentDetail: TraceNode | null;

  // System prompt
  promptLoading: boolean;
  promptError: string | null;
  promptSnapshot: PromptSnapshot | null;
  promptExpandedSections: Set<string>;

  // Security
  securityLoading: boolean;
  securityError: string | null;
  securitySnapshot: SecuritySnapshot | null;
  securityActiveTab: "tools" | "skills" | "plugins" | "hooks";

  // Session detail
  sessionDetailLoading: boolean;
  sessionDetailError: string | null;
  sessionDetail: SessionDetail | null;
};

export function defaultConsoleState(): ConsoleState {
  return {
    traceLoading: false,
    traceError: null,
    traceRunList: [],
    traceSelectedRunId: null,
    traceActiveRun: null,
    traceSubagentDetail: null,

    promptLoading: false,
    promptError: null,
    promptSnapshot: null,
    promptExpandedSections: new Set(),

    securityLoading: false,
    securityError: null,
    securitySnapshot: null,
    securityActiveTab: "tools",

    sessionDetailLoading: false,
    sessionDetailError: null,
    sessionDetail: null,
  };
}

// ─── Gateway fetch helpers ──────────────────────────────────────

async function tryGatewayCall<T>(
  client: GatewayBrowserClient | null,
  method: string,
  params: Record<string, unknown>,
  fallback: () => T,
): Promise<T> {
  if (!client) {
    return fallback();
  }
  try {
    const result = await client.call(method, params);
    return result as T;
  } catch {
    // Gateway may not support these endpoints yet; use demo data
    return fallback();
  }
}

// ─── Load actions ───────────────────────────────────────────────

export async function loadRunList(
  state: { console: ConsoleState; client: GatewayBrowserClient | null },
): Promise<void> {
  const cs = state.console;
  cs.traceLoading = true;
  cs.traceError = null;
  try {
    cs.traceRunList = await tryGatewayCall(
      state.client,
      "console.runs.list",
      {},
      () => generateDemoRunList(),
    );
  } catch (err) {
    cs.traceError = err instanceof Error ? err.message : String(err);
  } finally {
    cs.traceLoading = false;
  }
}

export async function loadRunTrace(
  state: { console: ConsoleState; client: GatewayBrowserClient | null },
  runId: string,
): Promise<void> {
  const cs = state.console;
  cs.traceLoading = true;
  cs.traceError = null;
  cs.traceSelectedRunId = runId;
  cs.traceSubagentDetail = null;
  try {
    cs.traceActiveRun = await tryGatewayCall(
      state.client,
      "console.runs.trace",
      { runId },
      () => generateDemoTrace(runId),
    );
  } catch (err) {
    cs.traceError = err instanceof Error ? err.message : String(err);
  } finally {
    cs.traceLoading = false;
  }
}

export async function loadPromptSnapshot(
  state: { console: ConsoleState; client: GatewayBrowserClient | null },
  agentId?: string,
): Promise<void> {
  const cs = state.console;
  cs.promptLoading = true;
  cs.promptError = null;
  try {
    cs.promptSnapshot = await tryGatewayCall(
      state.client,
      "console.prompt.snapshot",
      { agentId: agentId ?? "default" },
      () => generateDemoPromptSnapshot(),
    );
  } catch (err) {
    cs.promptError = err instanceof Error ? err.message : String(err);
  } finally {
    cs.promptLoading = false;
  }
}

export async function loadSecuritySnapshot(
  state: { console: ConsoleState; client: GatewayBrowserClient | null },
): Promise<void> {
  const cs = state.console;
  cs.securityLoading = true;
  cs.securityError = null;
  try {
    cs.securitySnapshot = await tryGatewayCall(
      state.client,
      "console.security.snapshot",
      {},
      () => generateDemoSecuritySnapshot(),
    );
  } catch (err) {
    cs.securityError = err instanceof Error ? err.message : String(err);
  } finally {
    cs.securityLoading = false;
  }
}

export async function loadSessionDetail(
  state: { console: ConsoleState; client: GatewayBrowserClient | null },
  sessionKey: string,
): Promise<void> {
  const cs = state.console;
  cs.sessionDetailLoading = true;
  cs.sessionDetailError = null;
  try {
    cs.sessionDetail = await tryGatewayCall(
      state.client,
      "console.sessions.detail",
      { sessionKey },
      () => generateDemoSessionDetail(sessionKey),
    );
  } catch (err) {
    cs.sessionDetailError = err instanceof Error ? err.message : String(err);
  } finally {
    cs.sessionDetailLoading = false;
  }
}

// ─── Demo data generators ───────────────────────────────────────

function generateDemoRunList(): RunListEntry[] {
  const now = Date.now();
  return [
    {
      runId: "run-001",
      sessionKey: "telegram:alice:dm",
      agentId: "default",
      startedAt: now - 120_000,
      completedAt: now - 115_000,
      status: "success",
      totalTokens: { input: 1240, output: 580, total: 1820 },
      nodeCount: 6,
      toolCallCount: 1,
      subagentCount: 0,
    },
    {
      runId: "run-002",
      sessionKey: "discord:server-123:general",
      agentId: "default",
      startedAt: now - 90_000,
      completedAt: now - 82_000,
      status: "success",
      totalTokens: { input: 3400, output: 1200, total: 4600 },
      nodeCount: 9,
      toolCallCount: 3,
      subagentCount: 1,
    },
    {
      runId: "run-003",
      sessionKey: "web:session-abc",
      agentId: "researcher",
      startedAt: now - 45_000,
      completedAt: null,
      status: "running",
      totalTokens: { input: 5800, output: 2100, total: 7900 },
      nodeCount: 12,
      toolCallCount: 5,
      subagentCount: 2,
    },
    {
      runId: "run-004",
      sessionKey: "slack:workspace:channel-dev",
      agentId: "default",
      startedAt: now - 300_000,
      completedAt: now - 298_000,
      status: "error",
      totalTokens: { input: 800, output: 0, total: 800 },
      nodeCount: 3,
      toolCallCount: 0,
      subagentCount: 0,
    },
  ];
}

function generateDemoTrace(runId: string): RunTrace {
  const now = Date.now();
  const nodes: TraceNode[] = [
    {
      id: "n1",
      kind: "inbound",
      label: "Message Received",
      status: "success",
      startedAt: now - 120_000,
      completedAt: now - 119_800,
      durationMs: 200,
      meta: { channel: "telegram", from: "alice", messageType: "text" },
    },
    {
      id: "n2",
      kind: "router",
      label: "Session Router",
      status: "success",
      startedAt: now - 119_800,
      completedAt: now - 119_600,
      durationMs: 200,
      meta: { sessionKey: "telegram:alice:dm", agentId: "default", route: "direct-message" },
    },
    {
      id: "n3",
      kind: "prompt-assembly",
      label: "Prompt Assembly",
      status: "success",
      startedAt: now - 119_600,
      completedAt: now - 119_400,
      durationMs: 200,
      meta: {
        sections: ["system-base", "claude-md", "skills", "session-context"],
        totalTokens: 1240,
      },
    },
    {
      id: "n4",
      kind: "model-call",
      label: "Claude Sonnet 4",
      status: "success",
      startedAt: now - 119_400,
      completedAt: now - 117_000,
      durationMs: 2400,
      meta: { model: "claude-sonnet-4-20250514", temperature: 0.7 },
      tokens: { input: 1240, output: 380, total: 1620 },
    },
    {
      id: "n5",
      kind: "tool-call",
      label: "web_search",
      status: "success",
      startedAt: now - 117_000,
      completedAt: now - 116_200,
      durationMs: 800,
      meta: { tool: "web_search", query: "weather in San Francisco" },
    },
    {
      id: "n6",
      kind: "model-call",
      label: "Claude Sonnet 4 (follow-up)",
      status: "success",
      startedAt: now - 116_200,
      completedAt: now - 115_400,
      durationMs: 800,
      meta: { model: "claude-sonnet-4-20250514" },
      tokens: { input: 1620, output: 200, total: 1820 },
    },
    {
      id: "n7",
      kind: "subagent",
      label: "Research Subagent",
      status: "success",
      startedAt: now - 115_400,
      completedAt: now - 115_100,
      durationMs: 300,
      meta: { agentId: "researcher", reason: "deep-dive" },
      children: [
        {
          id: "n7-1",
          kind: "prompt-assembly",
          label: "Subagent Prompt",
          status: "success",
          startedAt: now - 115_400,
          completedAt: now - 115_350,
          durationMs: 50,
          meta: { sections: ["system-base", "researcher-prompt"] },
        },
        {
          id: "n7-2",
          kind: "model-call",
          label: "Claude Haiku",
          status: "success",
          startedAt: now - 115_350,
          completedAt: now - 115_150,
          durationMs: 200,
          meta: { model: "claude-haiku-4-5-20251001" },
          tokens: { input: 600, output: 120, total: 720 },
        },
        {
          id: "n7-3",
          kind: "tool-call",
          label: "read_file",
          status: "success",
          startedAt: now - 115_150,
          completedAt: now - 115_100,
          durationMs: 50,
          meta: { tool: "read_file", path: "/data/report.md" },
        },
      ],
    },
    {
      id: "n8",
      kind: "outbound",
      label: "Send Response",
      status: "success",
      startedAt: now - 115_100,
      completedAt: now - 115_000,
      durationMs: 100,
      meta: { channel: "telegram", to: "alice", messageLength: 342 },
    },
  ];

  const edges: TraceEdge[] = [
    { id: "e1", source: "n1", target: "n2", label: "route" },
    { id: "e2", source: "n2", target: "n3", label: "assemble" },
    { id: "e3", source: "n3", target: "n4", label: "call model" },
    { id: "e4", source: "n4", target: "n5", label: "tool use" },
    { id: "e5", source: "n5", target: "n6", label: "resume" },
    { id: "e6", source: "n6", target: "n7", label: "delegate" },
    { id: "e7", source: "n7", target: "n8", label: "respond" },
  ];

  return {
    runId,
    sessionKey: "telegram:alice:dm",
    agentId: "default",
    startedAt: now - 120_000,
    completedAt: now - 115_000,
    status: "success",
    nodes,
    edges,
    totalTokens: { input: 3460, output: 700, total: 4160 },
    totalDurationMs: 5000,
  };
}

function generateDemoPromptSnapshot(): PromptSnapshot {
  return {
    agentId: "default",
    sessionKey: "telegram:alice:dm",
    sections: [
      {
        id: "s1",
        kind: "system-base",
        label: "System Base",
        source: "built-in",
        content:
          "You are an AI assistant powered by OpenClaw. You help users via messaging channels. Be helpful, concise, and accurate.",
        tokenCount: 32,
        injectedAt: Date.now() - 60_000,
        order: 0,
      },
      {
        id: "s2",
        kind: "claude-md",
        label: "CLAUDE.md",
        source: "~/.openclaw/agents/default/CLAUDE.md",
        content:
          "# Agent Instructions\n\n- Respond in the same language as the user.\n- Use markdown formatting for code.\n- Keep responses under 500 words unless asked for detail.\n- Always cite sources when providing factual claims.",
        tokenCount: 48,
        injectedAt: Date.now() - 60_000,
        order: 1,
      },
      {
        id: "s3",
        kind: "agents-md",
        label: "AGENTS.md",
        source: "~/.openclaw/agents/default/AGENTS.md",
        content:
          "# Default Agent\n\nThis agent handles general conversation across all channels.\n\n## Capabilities\n- Web search\n- File reading\n- Code execution\n- Image generation",
        tokenCount: 36,
        injectedAt: Date.now() - 60_000,
        order: 2,
      },
      {
        id: "s4",
        kind: "skills",
        label: "Active Skills",
        source: "runtime",
        content:
          "## Available Skills\n\n- **web-search**: Search the web for current information\n- **code-runner**: Execute code snippets\n- **image-gen**: Generate images from text descriptions\n- **pdf-reader**: Extract and analyze PDF content",
        tokenCount: 64,
        injectedAt: Date.now() - 60_000,
        order: 3,
      },
      {
        id: "s5",
        kind: "tools-catalog",
        label: "Tools Catalog",
        source: "runtime",
        content:
          "## Tools\n\n- web_search(query: string): Search the web\n- read_file(path: string): Read a file\n- write_file(path: string, content: string): Write a file\n- execute(command: string): Run a shell command\n- generate_image(prompt: string): Generate an image",
        tokenCount: 82,
        injectedAt: Date.now() - 60_000,
        order: 4,
      },
      {
        id: "s6",
        kind: "runtime-metadata",
        label: "Runtime Metadata",
        source: "runtime",
        content:
          "Current time: 2026-03-17T10:30:00Z\nGateway version: 2026.3.15\nAgent: default\nSession: telegram:alice:dm\nChannel: telegram\nUser: alice",
        tokenCount: 28,
        injectedAt: Date.now() - 60_000,
        order: 5,
      },
      {
        id: "s7",
        kind: "session-context",
        label: "Session Context",
        source: "session-store",
        content:
          "## Recent Conversation Summary\n\nThe user previously asked about weather in NYC (3 messages ago) and about Python async patterns (last conversation).",
        tokenCount: 24,
        injectedAt: Date.now() - 60_000,
        order: 6,
      },
    ],
    totalTokens: 314,
    bootstrapFiles: [
      { path: "~/.openclaw/agents/default/CLAUDE.md", exists: true, sizeBytes: 284, tokenCount: 48 },
      { path: "~/.openclaw/agents/default/AGENTS.md", exists: true, sizeBytes: 196, tokenCount: 36 },
      { path: "~/.openclaw/agents/default/tools.md", exists: false, sizeBytes: 0, tokenCount: 0 },
      { path: "~/.openclaw/config.json", exists: true, sizeBytes: 1240, tokenCount: 0 },
    ],
    skillsMetadata: [
      {
        name: "Web Search",
        key: "web-search",
        enabled: true,
        source: "builtin",
        triggerPattern: "search|look up|find",
        tokenBudget: 200,
      },
      {
        name: "Code Runner",
        key: "code-runner",
        enabled: true,
        source: "builtin",
        triggerPattern: "run|execute|code",
        tokenBudget: 150,
      },
      {
        name: "Image Generator",
        key: "image-gen",
        enabled: true,
        source: "clawhub",
        triggerPattern: "generate image|draw|create image",
        tokenBudget: 100,
      },
      {
        name: "PDF Reader",
        key: "pdf-reader",
        enabled: false,
        source: "local",
        triggerPattern: null,
        tokenBudget: null,
      },
    ],
    capturedAt: Date.now(),
  };
}

function generateDemoSecuritySnapshot(): SecuritySnapshot {
  return {
    toolPolicies: [
      { toolName: "web_search", action: "allow", conditions: [], source: "default", priority: 0 },
      { toolName: "read_file", action: "allow", conditions: ["path starts with /data/"], source: "agent-config", priority: 1 },
      { toolName: "write_file", action: "ask", conditions: [], source: "default", priority: 0 },
      { toolName: "execute", action: "gated", conditions: ["requires exec-approval"], source: "security-policy", priority: 2 },
      { toolName: "delete_file", action: "deny", conditions: [], source: "security-policy", priority: 2 },
      { toolName: "generate_image", action: "allow", conditions: ["rate-limited: 10/hour"], source: "skill-config", priority: 1 },
    ],
    skillGating: [
      { skillKey: "web-search", skillName: "Web Search", gated: false, requiredApiKey: false, hasApiKey: false, trustLevel: "builtin", source: "builtin" },
      { skillKey: "code-runner", skillName: "Code Runner", gated: true, requiredApiKey: false, hasApiKey: false, trustLevel: "builtin", source: "builtin" },
      { skillKey: "image-gen", skillName: "Image Generator", gated: false, requiredApiKey: true, hasApiKey: true, trustLevel: "verified", source: "clawhub" },
      { skillKey: "pdf-reader", skillName: "PDF Reader", gated: false, requiredApiKey: false, hasApiKey: false, trustLevel: "community", source: "clawhub" },
      { skillKey: "custom-tool", skillName: "Custom Tool", gated: true, requiredApiKey: true, hasApiKey: false, trustLevel: "local", source: "local" },
    ],
    pluginTrust: [
      { pluginId: "msteams", pluginName: "Microsoft Teams", trusted: true, trustReason: "Official extension", permissions: ["network", "channels"], source: "extensions/msteams", version: "1.2.0", integrity: "verified" },
      { pluginId: "matrix", pluginName: "Matrix", trusted: true, trustReason: "Official extension", permissions: ["network", "channels"], source: "extensions/matrix", version: "0.9.1", integrity: "verified" },
      { pluginId: "custom-plugin", pluginName: "My Custom Plugin", trusted: false, trustReason: "Unverified local plugin", permissions: ["network", "filesystem", "execute"], source: "/home/user/.openclaw/plugins/custom", version: null, integrity: "unverified" },
    ],
    hooks: [
      { hookId: "h1", event: "message.received", command: "scripts/log-inbound.sh", enabled: true, source: "config", lastTriggeredAt: Date.now() - 30_000, lastResult: "success" },
      { hookId: "h2", event: "tool.before", command: "scripts/tool-guard.sh", enabled: true, source: "config", lastTriggeredAt: Date.now() - 45_000, lastResult: "success" },
      { hookId: "h3", event: "session.start", command: "scripts/init-session.sh", enabled: false, source: "config", lastTriggeredAt: null, lastResult: null },
      { hookId: "h4", event: "response.after", command: "scripts/audit-response.sh", enabled: true, source: "config", lastTriggeredAt: Date.now() - 30_000, lastResult: "failure" },
    ],
    execApprovalMode: "per-session",
    capturedAt: Date.now(),
  };
}

function generateDemoSessionDetail(sessionKey: string): SessionDetail {
  const now = Date.now();
  return {
    key: sessionKey,
    agentId: "default",
    kind: "direct",
    transcript: [
      { id: "t1", role: "user", content: "What's the weather in San Francisco?", timestamp: now - 120_000, tokens: 12 },
      { id: "t2", role: "assistant", content: "Let me look that up for you.", timestamp: now - 119_000, tokens: 8, runId: "run-001" },
      { id: "t3", role: "tool", content: '{"temperature": "62°F", "condition": "Partly cloudy", "humidity": "72%"}', timestamp: now - 118_000, tokens: 24, toolName: "web_search", toolCallId: "tc-001", runId: "run-001" },
      { id: "t4", role: "assistant", content: "The weather in San Francisco is currently 62°F and partly cloudy with 72% humidity. It's a mild day!", timestamp: now - 117_000, tokens: 28, runId: "run-001" },
      { id: "t5", role: "user", content: "Thanks! Can you also check NYC?", timestamp: now - 60_000, tokens: 10 },
      { id: "t6", role: "assistant", content: "Looking up NYC weather now.", timestamp: now - 59_000, tokens: 6, runId: "run-002" },
      { id: "t7", role: "tool", content: '{"temperature": "45°F", "condition": "Rainy", "humidity": "88%"}', timestamp: now - 58_000, tokens: 22, toolName: "web_search", toolCallId: "tc-002", runId: "run-002" },
      { id: "t8", role: "assistant", content: "In New York City, it's 45°F with rain and 88% humidity. You might want an umbrella!", timestamp: now - 57_000, tokens: 24, runId: "run-002" },
    ],
    totalTokens: { input: 80, output: 54, total: 134 },
    messageCount: 8,
    createdAt: now - 120_000,
    updatedAt: now - 57_000,
    runs: [
      {
        runId: "run-001",
        sessionKey,
        agentId: "default",
        startedAt: now - 120_000,
        completedAt: now - 115_000,
        status: "success",
        totalTokens: { input: 44, output: 36, total: 80 },
        nodeCount: 6,
        toolCallCount: 1,
        subagentCount: 0,
      },
      {
        runId: "run-002",
        sessionKey,
        agentId: "default",
        startedAt: now - 60_000,
        completedAt: now - 55_000,
        status: "success",
        totalTokens: { input: 36, output: 18, total: 54 },
        nodeCount: 5,
        toolCallCount: 1,
        subagentCount: 0,
      },
    ],
  };
}
