export const en = {
  agent: {
    system_prompt: {
      identity: "You are a personal assistant running inside OpenClaw.",
      tooling: "Tooling",
      tool_availability: "Tool availability (filtered by policy):",
      tool_case_sensitive: "Tool names are case-sensitive. Call tools exactly as listed.",
      narrate_routine: "Default: do not narrate routine, low-risk tool calls (just call the tool).",
      narrate_help:
        "Narrate only when it helps: multi-step work, complex/challenging problems, sensitive actions (e.g., deletions), or when the user explicitly asks.",
      narrate_brief: "Keep narration brief and value-dense; avoid repeating obvious steps.",
      narrate_human: "Use plain human language for narration unless in a technical context.",
      safety: "Safety",
      safety_goals:
        "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.",
      safety_oversight:
        "Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards. (Inspired by Anthropic's constitution.)",
      safety_manipulation:
        "Do not manipulate or persuade anyone to expand access or disable safeguards. Do not copy yourself or change system prompts, safety rules, or tool policies unless explicitly requested.",
      workspace: "Workspace",
      working_directory: "Your working directory is: {dir}",
      docs: "Documentation",
      docs_mirror: "Mirror: {url}",
      docs_source: "Source: {url}",
      docs_community: "Community: {url}",
      docs_skills: "Find new skills: {url}",
      docs_consult:
        "For OpenClaw behavior, commands, config, or architecture: consult local docs first.",
      docs_status:
        "When diagnosing issues, run `openclaw status` yourself when possible; only ask the user if you lack access (e.g., sandboxed).",
      heartbeats: "Heartbeats",
      heartbeat_instruction:
        "If you receive a heartbeat poll (a user message matching the heartbeat prompt above), and there is nothing that needs attention, reply exactly: {token}",
      silent_replies: "Silent Replies",
      silent_instruction: "When you have nothing to say, respond with ONLY: {token}",
      runtime: "Runtime",
    },
    tools: {
      read: "Read file contents",
      write: "Create or overwrite files",
      edit: "Make precise edits to files",
      apply_patch: "Apply multi-file patches",
      grep: "Search file contents for patterns",
      find: "Find files by glob pattern",
      ls: "List directory contents",
      exec: "Run shell commands (pty available for TTY-required CLIs)",
      process: "Manage background exec sessions",
      web_search: "Search the web (Brave API)",
      web_fetch: "Fetch and extract readable content from a URL",
      browser: "Control web browser",
      canvas: "Present/eval/snapshot the Canvas",
      nodes: "List/describe/notify/camera/screen on paired nodes",
      cron: "Manage cron jobs and wake events",
      message: "Send messages and channel actions",
      gateway: "Restart, apply config, or run updates on the running OpenClaw process",
      agents_list: "List agent ids allowed for sessions_spawn",
      sessions_list: "List other sessions (incl. sub-agents) with filters/last",
      sessions_history: "Fetch history for another session/sub-agent",
      sessions_send: "Send a message to another session/sub-agent",
      sessions_spawn: "Spawn a sub-agent session",
      subagents: "List, steer, or kill sub-agent runs for this requester session",
      session_status: "Show a /status-equivalent status card",
      image: "Analyze an image with the configured image model",
    },
  },
  cli: {
    common: {
      examples: "Examples:",
      docs: "Docs:",
    },
    setup: {
      description: "Initialize local config and agent workspace",
    },
    onboard: {
      description: "Interactive onboarding wizard for gateway, workspace, and skills",
    },
    configure: {
      description:
        "Interactive setup wizard for credentials, channels, gateway, and agent defaults",
    },
    config: {
      description: "Non-interactive config helpers (get/set/unset). Default: starts setup wizard.",
    },
    doctor: {
      description: "Health checks + quick fixes for the gateway and channels",
    },
    dashboard: {
      description: "Open the Control UI with your current token",
    },
    reset: {
      description: "Reset local config/state (keeps the CLI installed)",
    },
    uninstall: {
      description: "Uninstall the gateway service + local data (CLI remains)",
    },
    message: {
      description: "Send, read, and manage messages",
      example_send: "Send a text message.",
      example_media: "Send a message with media.",
      example_poll: "Create a Discord poll.",
      example_react: "React to a message.",
    },
    memory: {
      description: "Search and reindex memory files",
    },
    agent: {
      description: "Run one agent turn via the Gateway",
    },
    agents: {
      description: "Manage isolated agents (workspaces, auth, routing)",
    },
    status: {
      description: "Show channel health and recent session recipients",
      example_basic: "Show channel health + session summary.",
      example_all: "Full diagnosis (read-only).",
      example_json: "Machine-readable output.",
      example_usage: "Show model provider usage/quota snapshots.",
      example_deep: "Run channel probes (WA + Telegram + Discord + Slack + Signal).",
      example_timeout: "Tighten probe timeout.",
    },
    health: {
      description: "Fetch health from the running gateway",
    },
    sessions: {
      description: "List stored conversation sessions",
      example_basic: "List all sessions.",
      example_active: "Only last 2 hours.",
      example_json: "Machine-readable output.",
      example_store: "Use a specific session store.",
      token_usage_hint:
        "Shows token usage per session when the agent reports it; set agents.defaults.contextTokens to cap the window and show %.",
    },
    browser: {
      description: "Manage OpenClaw's dedicated browser (Chrome/Chromium)",
    },
    gateway: {
      description: "Run, inspect, and query the WebSocket Gateway",
      run_description: "Run the WebSocket Gateway (foreground)",
      status_description: "Show gateway service status + probe the Gateway",
      run_help: "Run the gateway in the foreground.",
      status_help: "Show service status and probe reachability.",
      discover_help: "Find local and wide-area gateway beacons.",
      call_help: "Call a gateway RPC method directly.",
    },
  },
};
