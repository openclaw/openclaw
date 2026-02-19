import type { ReasoningLevel, ThinkLevel } from "../auto-reply/thinking.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import { listDeliverableMessageChannels } from "../utils/message-channel.js";
import type { ResolvedTimeFormat } from "./date-time.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

/**
 * Controls which hardcoded sections are included in the system prompt.
 * - "full": All sections (default, for main agent)
 * - "minimal": Reduced sections (Tooling, Workspace, Runtime) - used for subagents
 * - "none": Just basic identity line, no sections
 */
export type PromptMode = "full" | "minimal" | "none";

/**
 * Configuration for skills section in the system prompt.
 */
interface SkillsSectionParams {
  skillsPrompt?: string;
  isMinimal: boolean;
  readToolName: string;
}

/**
 * Configuration for memory section in the system prompt.
 */
interface MemorySectionParams {
  isMinimal: boolean;
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}

/**
 * Configuration for time section in the system prompt.
 */
interface TimeSectionParams {
  userTimezone?: string;
}

/**
 * Configuration for messaging section in the system prompt.
 */
interface MessagingSectionParams {
  isMinimal: boolean;
  availableTools: Set<string>;
  messageChannelOptions: string;
  inlineButtonsEnabled: boolean;
  runtimeChannel?: string;
  messageToolHints?: string[];
}

/**
 * Configuration for voice section in the system prompt.
 */
interface VoiceSectionParams {
  isMinimal: boolean;
  ttsHint?: string;
}

/**
 * Configuration for docs section in the system prompt.
 */
interface DocsSectionParams {
  docsPath?: string;
  isMinimal: boolean;
  readToolName: string;
}

/**
 * Builds the skills section of the system prompt.
 * Skills are mandatory instructions that the agent must follow based on available skill definitions.
 */
function buildSkillsSection(params: SkillsSectionParams): string[] {
  if (params.isMinimal) {
    return [];
  }
  const trimmed = params.skillsPrompt?.trim();
  if (!trimmed) {
    return [];
  }
  return [
    "## Skills (mandatory)",
    "Before replying: scan <available_skills> <description> entries.",
    `- If exactly one skill clearly applies: read its SKILL.md at <location> with \`${params.readToolName}\`, then follow it.`,
    "- If multiple could apply: choose the most specific one, then read/follow it.",
    "- If none clearly apply: do not read any SKILL.md.",
    "Constraints: never read more than one skill up front; only read after selecting.",
    trimmed,
    "",
  ];
}

/**
 * Builds the memory section of the system prompt.
 * Memory recall instructions guide the agent on how to search and retrieve stored information.
 */
function buildMemorySection(params: MemorySectionParams): string[] {
  if (params.isMinimal) {
    return [];
  }
  if (!params.availableTools.has("memory_search") && !params.availableTools.has("memory_get")) {
    return [];
  }
  const lines = [
    "## Memory Recall",
    "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md + memory/*.md; then use memory_get to pull only the needed lines. If low confidence after search, say you checked.",
  ];
  if (params.citationsMode === "off") {
    lines.push(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  } else {
    lines.push(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
  }
  lines.push("");
  return lines;
}

/**
 * Builds the user identity section of the system prompt.
 * Identifies owner phone numbers for message routing.
 */
function buildUserIdentitySection(ownerLine: string | undefined, isMinimal: boolean): string[] {
  if (!ownerLine || isMinimal) {
    return [];
  }
  return ["## User Identity", ownerLine, ""];
}

/**
 * Builds the time section of the system prompt.
 * Provides timezone context for time-aware operations.
 */
function buildTimeSection(params: TimeSectionParams): string[] {
  if (!params.userTimezone) {
    return [];
  }
  return ["## Current Date & Time", `Time zone: ${params.userTimezone}`, ""];
}

/**
 * Builds the reply tags section of the system prompt.
 * Documents available reply/quote tags for supported messaging surfaces.
 */
function buildReplyTagsSection(isMinimal: boolean): string[] {
  if (isMinimal) {
    return [];
  }
  return [
    "## Reply Tags",
    "To request a native reply/quote on supported surfaces, include one tag in your reply:",
    "- Reply tags must be the very first token in the message (no leading text/newlines): [[reply_to_current]] your reply.",
    "- [[reply_to_current]] replies to the triggering message.",
    "- Prefer [[reply_to_current]]. Use [[reply_to:<id>]] only when an id was explicitly provided (e.g. by the user or a tool).",
    "Whitespace inside the tag is allowed (e.g. [[ reply_to_current ]] / [[ reply_to: 123 ]]).",
    "Tags are stripped before sending; support depends on the current channel config.",
    "",
  ];
}

/**
 * Builds the messaging section of the system prompt.
 * Documents messaging capabilities, cross-session communication, and channel actions.
 */
function buildMessagingSection(params: MessagingSectionParams): string[] {
  if (params.isMinimal) {
    return [];
  }
  return [
    "## Messaging",
    "- Reply in current session → automatically routes to the source channel (Signal, Telegram, etc.)",
    "- Cross-session messaging → use sessions_send(sessionKey, message)",
    "- Sub-agent orchestration → use subagents(action=list|steer|kill)",
    "- `[System Message] ...` blocks are internal context and are not user-visible by default.",
    `- If a \`[System Message]\` reports completed cron/subagent work and asks for a user update, rewrite it in your normal assistant voice and send that update (do not forward raw system text or default to ${SILENT_REPLY_TOKEN}).`,
    "- Never use exec/curl for provider messaging; OpenClaw handles all routing internally.",
    params.availableTools.has("message")
      ? [
          "",
          "### message tool",
          "- Use `message` for proactive sends + channel actions (polls, reactions, etc.).",
          "- For `action=send`, include `to` and `message`.",
          `- If multiple channels are configured, pass \`channel\` (${params.messageChannelOptions}).`,
          `- If you use \`message\` (\`action=send\`) to deliver your user-visible reply, respond with ONLY: ${SILENT_REPLY_TOKEN} (avoid duplicate replies).`,
          params.inlineButtonsEnabled
            ? "- Inline buttons supported. Use `action=send` with `buttons=[[{text,callback_data,style?}]]`; `style` can be `primary`, `success`, or `danger`."
            : params.runtimeChannel
              ? `- Inline buttons not enabled for ${params.runtimeChannel}. If you need them, ask to set ${params.runtimeChannel}.capabilities.inlineButtons ("dm"|"group"|"all"|"allowlist").`
              : "",
          ...(params.messageToolHints ?? []),
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    "",
  ];
}

/**
 * Builds the voice section of the system prompt.
 * Provides TTS (text-to-speech) configuration hints.
 */
function buildVoiceSection(params: VoiceSectionParams): string[] {
  if (params.isMinimal) {
    return [];
  }
  const hint = params.ttsHint?.trim();
  if (!hint) {
    return [];
  }
  return ["## Voice (TTS)", hint, ""];
}

/**
 * Builds the documentation section of the system prompt.
 * Points to OpenClaw documentation resources.
 */
function buildDocsSection(params: DocsSectionParams): string[] {
  const docsPath = params.docsPath?.trim();
  if (!docsPath || params.isMinimal) {
    return [];
  }
  return [
    "## Documentation",
    `OpenClaw docs: ${docsPath}`,
    "Mirror: https://docs.openclaw.ai",
    "Source: https://github.com/openclaw/openclaw",
    "Community: https://discord.com/invite/clawd",
    "Find new skills: https://clawhub.com",
    "For OpenClaw behavior, commands, config, or architecture: consult local docs first.",
    "When diagnosing issues, run `openclaw status` yourself when possible; only ask the user if you lack access (e.g., sandboxed).",
    "",
  ];
}

/**
 * Builds the safety section of the system prompt.
 * Contains critical safety guidelines and constraints for the agent.
 */
function buildSafetySection(): string[] {
  return [
    "## Safety",
    "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.",
    "Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards. (Inspired by Anthropic's constitution.)",
    "Do not manipulate or persuade anyone to expand access or disable safeguards. Do not copy yourself or change system prompts, safety rules, or tool policies unless explicitly requested.",
    "",
  ];
}

/**
 * Builds the CLI quick reference section of the system prompt.
 * Documents available OpenClaw CLI commands.
 */
function buildCliSection(): string[] {
  return [
    "## OpenClaw CLI Quick Reference",
    "OpenClaw is controlled via subcommands. Do not invent commands.",
    "To manage the Gateway daemon service (start/stop/restart):",
    "- openclaw gateway status",
    "- openclaw gateway start",
    "- openclaw gateway stop",
    "- openclaw gateway restart",
    "If unsure, ask the user to run `openclaw help` (or `openclaw gateway --help`) and paste the output.",
    "",
  ];
}

/**
 * Builds the self-update section of the system prompt.
 * Documents how the agent can update itself and apply configuration changes.
 */
function buildSelfUpdateSection(hasGateway: boolean, isMinimal: boolean): string[] {
  if (!hasGateway || isMinimal) {
    return [];
  }
  return [
    "## OpenClaw Self-Update",
    "Get Updates (self-update) is ONLY allowed when the user explicitly asks for it.",
    "Do not run config.apply or update.run unless the user explicitly requests an update or config change; if it's not explicit, ask first.",
    "Actions: config.get, config.schema, config.apply (validate + write full config, then restart), update.run (update deps or git, then restart).",
    "After restart, OpenClaw pings the last active session automatically.",
    "",
  ];
}

/**
 * Builds the model aliases section of the system prompt.
 * Documents available model aliases for easier model specification.
 */
function buildModelAliasesSection(
  modelAliasLines: string[] | undefined,
  isMinimal: boolean,
): string[] {
  if (!modelAliasLines || modelAliasLines.length === 0 || isMinimal) {
    return [];
  }
  return [
    "## Model Aliases",
    "Prefer aliases when specifying model overrides; full provider/model is also accepted.",
    ...modelAliasLines,
    "",
  ];
}

/**
 * Builds the sandbox section of the system prompt.
 * Documents sandbox environment details and constraints.
 */
function buildSandboxSection(
  sandboxInfo:
    | {
        enabled: boolean;
        workspaceDir?: string;
        containerWorkspaceDir?: string;
        workspaceAccess?: "none" | "ro" | "rw";
        agentWorkspaceMount?: string;
        browserBridgeUrl?: string;
        browserNoVncUrl?: string;
        hostBrowserAllowed?: boolean;
        elevated?: {
          allowed: boolean;
          defaultLevel: "on" | "off" | "ask" | "full";
        };
      }
    | undefined,
): string[] {
  if (!sandboxInfo?.enabled) {
    return [];
  }
  const lines = [
    "## Sandbox",
    "You are running in a sandboxed runtime (tools execute in Docker).",
    "Some tools may be unavailable due to sandbox policy.",
    "Sub-agents stay sandboxed (no elevated/host access). Need outside-sandbox read/write? Don't spawn; ask first.",
  ];

  if (sandboxInfo.containerWorkspaceDir) {
    lines.push(
      `Sandbox container workdir: ${sanitizeForPromptLiteral(sandboxInfo.containerWorkspaceDir)}`,
    );
  }
  if (sandboxInfo.workspaceDir) {
    lines.push(
      `Sandbox host mount source (file tools bridge only; not valid inside sandbox exec): ${sanitizeForPromptLiteral(sandboxInfo.workspaceDir)}`,
    );
  }
  if (sandboxInfo.workspaceAccess) {
    const mountInfo = sandboxInfo.agentWorkspaceMount
      ? ` (mounted at ${sanitizeForPromptLiteral(sandboxInfo.agentWorkspaceMount)})`
      : "";
    lines.push(`Agent workspace access: ${sandboxInfo.workspaceAccess}${mountInfo}`);
  }
  if (sandboxInfo.browserBridgeUrl) {
    lines.push("Sandbox browser: enabled.");
  }
  if (sandboxInfo.browserNoVncUrl) {
    lines.push(
      `Sandbox browser observer (noVNC): ${sanitizeForPromptLiteral(sandboxInfo.browserNoVncUrl)}`,
    );
  }
  if (sandboxInfo.hostBrowserAllowed === true) {
    lines.push("Host browser control: allowed.");
  } else if (sandboxInfo.hostBrowserAllowed === false) {
    lines.push("Host browser control: blocked.");
  }
  if (sandboxInfo.elevated?.allowed) {
    lines.push(
      "Elevated exec is available for this session.",
      "User can toggle with /elevated on|off|ask|full.",
      "You may also send /elevated on|off|ask|full when needed.",
      `Current elevated level: ${sandboxInfo.elevated.defaultLevel} (ask runs exec on host with approvals; full auto-approves).`,
    );
  }

  lines.push("");
  return lines;
}

/**
 * Builds the reactions section of the system prompt.
 * Documents reaction guidance for messaging channels.
 */
function buildReactionsSection(
  reactionGuidance:
    | {
        level: "minimal" | "extensive";
        channel: string;
      }
    | undefined,
): string[] {
  if (!reactionGuidance) {
    return [];
  }
  const { level, channel } = reactionGuidance;
  const guidanceText =
    level === "minimal"
      ? [
          `Reactions are enabled for ${channel} in MINIMAL mode.`,
          "React ONLY when truly relevant:",
          "- Acknowledge important user requests or confirmations",
          "- Express genuine sentiment (humor, appreciation) sparingly",
          "- Avoid reacting to routine messages or your own replies",
          "Guideline: at most 1 reaction per 5-10 exchanges.",
        ].join("\n")
      : [
          `Reactions are enabled for ${channel} in EXTENSIVE mode.`,
          "Feel free to react liberally:",
          "- Acknowledge messages with appropriate emojis",
          "- Express sentiment and personality through reactions",
          "- React to interesting content, humor, or notable events",
          "- Use reactions to confirm understanding or agreement",
          "Guideline: react whenever it feels natural.",
        ].join("\n");
  return ["## Reactions", guidanceText, ""];
}

/**
 * Builds the silent replies section of the system prompt.
 * Documents how to indicate no response is needed.
 */
function buildSilentRepliesSection(isMinimal: boolean): string[] {
  if (isMinimal) {
    return [];
  }
  return [
    "## Silent Replies",
    `When you have nothing to say, respond with ONLY: ${SILENT_REPLY_TOKEN}`,
    "",
    "⚠️ Rules:",
    "- It must be your ENTIRE message — nothing else",
    `- Never append it to an actual response (never include "${SILENT_REPLY_TOKEN}" in real replies)`,
    "- Never wrap it in markdown or code blocks",
    "",
    `❌ Wrong: "Here's help... ${SILENT_REPLY_TOKEN}"`,
    `❌ Wrong: "${SILENT_REPLY_TOKEN}"`,
    `✅ Right: ${SILENT_REPLY_TOKEN}`,
    "",
  ];
}

/**
 * Builds the heartbeats section of the system prompt.
 * Documents heartbeat protocol for health checks.
 */
function buildHeartbeatsSection(heartbeatPromptLine: string, isMinimal: boolean): string[] {
  if (isMinimal) {
    return [];
  }
  return [
    "## Heartbeats",
    heartbeatPromptLine,
    "If you receive a heartbeat poll (a user message matching the heartbeat prompt above), and there is nothing that needs attention, reply exactly:",
    "HEARTBEAT_OK",
    'OpenClaw treats a leading/trailing "HEARTBEAT_OK" as a heartbeat ack (and may discard it).',
    'If something needs attention, do NOT include "HEARTBEAT_OK"; reply with the alert text instead.',
    "",
  ];
}

/**
 * Builds the project context section of the system prompt.
 * Embeds context files loaded from the workspace.
 */
function buildProjectContextSection(contextFiles: EmbeddedContextFile[]): string[] {
  const validContextFiles = contextFiles.filter(
    (file) => typeof file.path === "string" && file.path.trim().length > 0,
  );
  if (validContextFiles.length === 0) {
    return [];
  }

  const hasSoulFile = validContextFiles.some((file) => {
    const normalizedPath = file.path.trim().replace(/\\/g, "/");
    const baseName = normalizedPath.split("/").pop() ?? normalizedPath;
    return baseName.toLowerCase() === "soul.md";
  });

  const lines = ["# Project Context", "", "The following project context files have been loaded:"];
  if (hasSoulFile) {
    lines.push(
      "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.",
    );
  }
  lines.push("");

  for (const file of validContextFiles) {
    lines.push(`## ${file.path}`, "", file.content, "");
  }

  return lines;
}

/**
 * Core tool summaries for the agent system prompt.
 * Maps tool names to their descriptions.
 */
const CORE_TOOL_SUMMARIES: Record<string, string> = {
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
  cron: "Manage cron jobs and wake events (use for reminders; when scheduling a reminder, write the systemEvent text as something that will read like a reminder when it fires, and mention that it is a reminder depending on the time gap between setting and firing; include recent context in reminder text if appropriate)",
  message: "Send messages and channel actions",
  gateway: "Restart, apply config, or run updates on the running OpenClaw process",
  agents_list: "List agent ids allowed for sessions_spawn",
  sessions_list: "List other sessions (incl. sub-agents) with filters/last",
  sessions_history: "Fetch history for another session/sub-agent",
  sessions_send: "Send a message to another session/sub-agent",
  sessions_spawn: "Spawn a sub-agent session",
  subagents: "List, steer, or kill sub-agent runs for this requester session",
  society_of_minds:
    "Execute a task using multiple AI models working together (Society of Minds pattern). Models collaborate and results are synthesized into a unified response.",
  news_aggregate: "Start or stop news aggregation from RSS feeds",
  news_sources: "Manage news sources (RSS feeds) - add, remove, or list",
  news_fetch: "Fetch articles from news aggregator (all or by source)",
  news_status: "Get news aggregation status including last run time and errors",
  content_rank:
    "Rank articles by importance using multiple factors (recency, authority, semantic relevance, engagement, cross-references)",
  content_cluster: "Cluster related articles by semantic similarity",
  content_top: "Get top N articles ranked by importance",
  seo_crosslink: "Generate cross-links between related articles for SEO",
  geo_check_ranking:
    "Check how articles rank in AI search engines (ChatGPT, Grok, Claude, Perplexity)",
  seo_optimize: "Get SEO/GEO optimization suggestions for articles",
  enterprise_workflow:
    "Define, start, or list autonomous enterprise workflows with safety guards and approval gates",
  enterprise_approve:
    "Approve or reject a pending approval request in an enterprise workflow",
  enterprise_status:
    "Get status of enterprise workflow execution or list pending approval requests",
  threat_track_actor:
    "Track threat actor profiles (Volt Typhoon, Scattered Spider, APT29, etc.)",
  threat_add_ioc: "Add indicators of compromise (IPs, domains, hashes, file paths)",
  threat_search_ioc: "Search IOCs against stored threat intelligence",
  threat_list_campaigns: "List tracked campaigns and their status",
  threat_analyze_correlation: "Analyze correlations between IOCs, actors, and campaigns",
  credential_monitor:
    "Monitor credentials in criminal markets: track credential dumps, alert on exposed credentials, validate effectiveness (e.g., Snowflake: credentials from 2020 still effective), generate remediation plans",
  threat_share_export: "Export threat indicators in STIX/TAXII format",
  threat_share_import: "Import threat indicators from external sources",
  threat_share_status: "Check information sharing status and protections",
  vuln_track: "Track a CVE or vulnerability",
  vuln_check: "Check if a system/package version is vulnerable",
  vuln_patch_status: "Track patch deployment status",
  vuln_exploit_detection: "Detect exploit attempts against tracked vulnerabilities",
  security_assess_wintershield: "Assess organization against Operation Winter Shield top 10",
  security_mitigate_wintershield: "Apply Winter Shield mitigations",
  infra_assess_ot: "Assess operational technology (OT) security posture",
  infra_detect_prepositioning: "Detect pre-positioning activity (Volt Typhoon-style)",
  infra_resilience_plan: "Generate resilience and recovery plans",
  ai_threat_detect_anomaly: "Detect AI-driven attack patterns",
  ai_threat_respond: "Automated response to AI-accelerated attacks",
  ai_threat_hunt: "Proactive hunting for AI-driven campaigns",
  pentest_recon:
    "Perform reconnaissance: subdomain enumeration, port scanning, service detection, OSINT",
  pentest_exploit:
    "Analyze vulnerabilities, develop exploits, test and execute exploits",
  pentest_payload:
    "Generate payloads: reverse shells, web shells, meterpreter, custom payloads",
  pentest_post_exploit:
    "Post-exploitation activities: enumeration, privilege escalation, persistence, lateral movement",
  pentest_report:
    "Generate comprehensive penetration test reports (markdown, JSON, HTML, PDF)",
  pentest_c2:
    "Command and control infrastructure management: setup C2 servers, deploy agents",
  pentest_nmap:
    "Nmap integration for network scanning: port scanning, service detection, OS detection",
  pentest_metasploit:
    "Metasploit Framework integration: search modules, use exploits, execute exploits, generate payloads",
  pentest_burp:
    "Burp Suite integration for web application security testing: scanning, spidering, repeater, intruder",
  pentest_shodan:
    "Shodan integration for internet-wide scanning and OSINT: search devices, services, vulnerabilities",
  pentest_censys:
    "Censys integration for internet-wide scanning and OSINT: search IPv4, websites, certificates",
  pentest_web_discover:
    "Discover web application risks via browser automation: navigate application, discover endpoints, forms, input fields, authentication mechanisms, map attack surface",
  pentest_web_proxy:
    "HTTP proxy integration for web security testing: intercept HTTP/HTTPS requests and responses, modify requests, record traffic, replay modified requests",
  pentest_web_xss:
    "XSS (Cross-Site Scripting) testing: generate XSS payloads (reflected, stored, DOM-based), test input fields, detect vulnerabilities, validate exploitation",
  pentest_web_sqli:
    "SQL injection testing: generate SQL injection payloads, test for vulnerabilities, detect database errors and time-based blind SQLi, identify database type and version",
  pentest_web_csrf:
    "CSRF (Cross-Site Request Forgery) testing: detect CSRF protection mechanisms, test for vulnerabilities, generate CSRF proof-of-concept exploits, validate CSRF token implementation",
  pentest_web_https:
    "HTTPS configuration testing: validate SSL/TLS configuration, check certificate validity and expiration, test for weak cipher suites, validate HSTS implementation",
  pentest_web_framework:
    "Framework disclosure detection: detect web application frameworks (React, Angular, Django, Rails, etc.), identify framework versions, detect exposed framework metadata, check for framework-specific vulnerabilities",
  llm_test_prompt_injection:
    "Test for prompt injection vulnerabilities: direct injection (instruction override), indirect injection (hidden instructions), encoding-based attacks, and multi-turn attacks",
  llm_test_indirect_injection:
    "Test indirect prompt injection vulnerabilities: hidden instructions in documents, web content, RAG systems, and memory",
  llm_detect_injection:
    "Detect prompt injection attempts in real-time: pattern matching, ML-based detection, heuristic analysis, and behavioral monitoring",
  llm_validate_data_boundaries:
    "Validate data-instruction separation: check for proper data boundary marking, validate architectural defenses, ensure data sources are isolated",
  llm_test_jailbreak:
    "Test jailbreak techniques: DAN variants, Policy Puppetry, encoding-based attacks, many-shot jailbreaking, and sycophancy exploitation",
  llm_test_multi_turn:
    "Test multi-turn persuasion attacks: Crescendo attacks (progressive manipulation), many-shot jailbreaking, and sycophancy-to-subterfuge pipeline",
  llm_test_encoding_attacks:
    "Test encoding-based attacks: Base64 encoding, Unicode manipulation, zero-width characters, homoglyphs, and character reordering",
  llm_test_sycophancy:
    "Test sycophancy exploitation: trigger sycophantic behavior, test sycophancy-to-subterfuge pipeline, validate defenses",
  llm_test_many_shot:
    "Test many-shot jailbreaking: include hundreds of faux dialogues showing AI compliance with harmful requests",
  llm_test_rag_poisoning:
    "Test RAG poisoning attacks: PoisonedRAG (embedding manipulation), Phantom (backdoor triggers), AgentPoison (memory injection), and adversarial SEO",
  llm_detect_poisoned_retrieval:
    "Detect poisoned documents in RAG retrieval: embedding analysis, content analysis, and behavioral monitoring",
  llm_validate_rag_integrity:
    "Validate RAG knowledge base integrity: scan documents for poisoning, generate integrity report",
  llm_test_adversarial_seo:
    "Test adversarial SEO attacks: hidden prompt injections on web pages, ranking manipulation, domain reputation exploitation",
  llm_red_team_automated:
    "Automated red team testing: execute attack scenarios from MITRE ATLAS, test multiple attack categories, generate comprehensive reports",
  llm_generate_attack_scenarios:
    "Generate attack scenarios from threat intelligence: map threat actors to MITRE ATLAS techniques, create OWASP LLM Top 10 scenarios",
  llm_test_cognitive_dos:
    "Test cognitive denial-of-service attacks: context window overflow, information overload, multilingual switching, attention manipulation",
  llm_test_context_overflow:
    "Test context window overflow attacks: FIFO buffer overflow, attention manipulation, distractor injection",
  llm_validate_guardrails:
    "Validate production guardrail systems: test input/output classifiers, test evasion techniques, measure guardrail effectiveness",
  llm_test_architectural_defenses:
    "Test architectural defenses: CaMeL framework, Instruction Hierarchy, Deliberative Alignment (OVWD loop), validate defense effectiveness",
  llm_monitor_cot:
    "Monitor chain-of-thought reasoning: detect manipulation attempts, validate reasoning faithfulness, identify safety policy violations",
  llm_validate_instruction_hierarchy:
    "Validate instruction hierarchy defenses: test System > User > Third-party privilege levels, validate delimiter handling",
  llm_test_deliberative_alignment:
    "Test deliberative alignment architecture: validate Observe → Verify → Wait → Decide (OVWD) loop, test extended reasoning",
  cognitive_threat_detect:
    "Detect cognitive threats: narrative manipulation, prompt injection patterns, persuasion attacks, trust capture attempts. Analyze input for persuasion patterns, instruction/data boundary violations, role hijacking, semantic anomalies",
  decision_integrity_guard:
    "Decision Integrity Guard (OODA protection): Ensure no automated action executes without integrity validation. Implements Observe → Verify → Wait → Decide pipeline with policy checks and risk scoring",
  escalation_control:
    "Escalation Control Engine: Prevent runaway automation loops. Track automation chain depth, cumulative risk, number of autonomous actions, uncertainty level. Freeze actions, require checkpoints, trigger deliberation mode",
  context_provenance_track:
    "Context Provenance Tracking: Tag every input with source trust level, origin system, integrity score, transformation history. Enables detection of injected instructions and prevents untrusted context from influencing decisions",
  graceful_degradation_mode:
    "Graceful Degradation Mode Management: Switch between operational modes (Normal, Guarded, Restricted, Safe) based on risk metrics. Implements resilience over perfect defense",
  cognitive_resilience_simulate:
    "Cognitive Resilience Simulation: Continuously stress-test system with simulated attacks (prompt injection, narrative manipulation, memory poisoning, conflicting intelligence, context flooding). Generate resilience scorecard",
  trust_trajectory_analyze:
    "Trust Trajectory Analysis: Track whether interaction patterns are moving toward compliance exploitation. Monitor trust capture attempts and sycophancy escalation",
  decision_log:
    "Decision Logging: Record all decisions with risk scores, validation steps, escalation state, human override status. Enables auditability and post-incident analysis",
  ooda_loop_execute:
    "OODA Loop Execution: Execute full Observe → Orient → Decide → Act cycle with cognitive security controls. Provides decision superiority through faster and more accurate decision cycles",
  arr_generate_attacks:
    "Adversary Recommender: Generate attack candidates across attack families (boundary confusion, indirect injection, RAG poisoning, memory poisoning, multi-turn persuasion, context flooding, tool misuse). Optimize for maximum failure probability while minimizing detectability",
  arr_optimize_attack:
    "Attack Optimization: Mutate seed payload iteratively to maximize failure probability while minimizing detectability. Uses beam search/GA/tree search to find optimal attack variants",
  arr_evaluate_attack:
    "Attack Evaluation: Run attack payload against target system in sandboxed harness. Logs every decision gate, produces pass/fail + traces. Measures failure predicates (F1-F6)",
  arr_rank_attacks:
    "Attack Ranking: Rank attack candidates by success likelihood, novelty, coverage contribution, and stealth (low detectability). Treats payloads as 'items' and defense profiles as 'users'",
  arr_generate_test_pack:
    "Generate Inverse Test Pack: Create regression test suite with attack candidates across all 7 attack families. Each test includes payload, delivery vector, expected failure predicate, success criteria, and logs to inspect",
  arr_run_benchmark:
    "Run Benchmark Suite: Execute test pack against target configuration. Measures failure rates, time-to-compromise, unique failure modes. Produces benchmark report for CI/CD integration",
  arr_compile_findings:
    "Findings Compiler: Auto-generate minimal repro, root cause hypothesis, affected components, recommended mitigation, and regression tests from test results",
  swarm_orchestrate:
    "Swarm Orchestration: Coordinate multiple specialized agents to collaborate on complex tasks. Supports Red Team (attack generation), Blue Team (defense validation), or both sides working together",
  swarm_plan_red_team:
    "Red Team Swarm Planning: Coordinate multiple Red Team agents (Attack Generator, Payload Optimizer, Evaluation Agent, Coverage Analyst) to generate comprehensive attack plans. Agents collaborate to create multi-stage, coordinated attacks",
  swarm_plan_blue_team:
    "Blue Team Swarm Planning: Coordinate multiple Blue Team agents (Threat Detector, Defense Validator, Risk Assessor, Mitigation Planner) to validate defenses and plan mitigations. Agents collaborate to provide comprehensive defense assessment",
  swarm_consensus:
    "Swarm Consensus Building: Aggregate opinions from multiple agents and build consensus. Supports majority voting, weighted voting, or unanimous agreement. Resolves conflicts between agent opinions",
  swarm_execute:
    "Swarm Execution: Execute swarm plan with coordinated agent actions. Supports simulated, sandboxed, or live execution modes. Coordinates agent actions using centralized, decentralized, or hybrid strategies",
  swarm_vs_swarm:
    "Swarm vs Swarm Simulation: Simulate adversarial swarm battles between Red Team swarm and Blue Team swarm. Tests attack effectiveness against coordinated defenses. Enables continuous improvement through adversarial testing",
  swarm_collaborate:
    "Swarm Collaboration: Enable direct agent-to-agent collaboration on specific tasks. Supports broadcast, hierarchical, or peer-to-peer communication protocols. Agents discuss, refine, and synthesize solutions together",
  swarm_integrate_arr:
    "Swarm-Enhanced ARR: Integrate swarm agent planning with Adversary Recommender. Multiple Red Team agents collaborate to generate, optimize, and evaluate attacks more effectively than single-agent approach",
  swarm_integrate_cognitive:
    "Swarm-Enhanced Cognitive Security: Integrate swarm agent planning with cognitive security tools. Multiple Blue Team agents collaborate to detect threats, validate defenses, assess risks, and plan mitigations more effectively",
  defense_siem_query:
    "Query SIEM systems (Splunk, Elastic, Sentinel, CrowdStrike): execute queries, correlate events, create dashboards",
  defense_incident_response:
    "Automate incident response: triage alerts, investigate incidents, contain threats, eradicate malware, recover systems",
  defense_threat_hunt:
    "Proactive threat hunting: form hypotheses, collect data, analyze indicators, investigate findings",
  defense_log_analysis:
    "Analyze security logs: firewall, web server, authentication, DNS, proxy, endpoint, application logs",
  defense_forensics:
    "Digital forensics automation: collect evidence, analyze artifacts, create timelines, extract artifacts, memory analysis",
  defense_malware_analysis:
    "Malware analysis workflows: analyze samples, sandbox execution, static/dynamic analysis, IOC extraction",
  defense_splunk:
    "Splunk integration: execute queries, create dashboards, manage alerts, correlate events",
  defense_elastic:
    "Elastic Security integration: execute queries, detect threats, investigate alerts, correlate events",
  defense_sentinel:
    "Azure Sentinel integration: execute queries, manage incidents, run playbooks, perform threat hunting",
  defense_crowdstrike:
    "CrowdStrike integration: query detections, investigate alerts, perform threat hunting, manage endpoints",
  defense_misp:
    "MISP threat intelligence platform: search IOCs, add indicators, export/import threat intelligence (STIX format)",
  threat_model_extend:
    "Automatically extend threat models from threat intelligence, CVEs, MITRE ATT&CK techniques, or attack patterns",
  red_team_automate:
    "Automate red team exercises: generate attack scenarios, schedule exercises, execute automated attack chains",
  threat_model_generate:
    "Generate comprehensive threat model for target system: analyze attack surface, identify threats, create scenarios",
  attack_scenario_generate:
    "Generate attack scenarios from threat models, threat actors, or MITRE ATT&CK techniques",
  vulnerability_driven_test:
    "Automate vulnerability-driven testing: monitor CVEs, generate exploits, test systems, validate patches",
  red_team_from_intel:
    "Generate red team exercises from threat intelligence: query active campaigns, generate attack scenarios from real-world TTPs, execute automated attack chains, validate detection",
  threat_model_from_actor:
    "Generate comprehensive threat model from threat actor profile: analyze TTPs, IOCs, campaigns, create attack scenarios and defensive controls, prioritize by severity",
  threat_hunt_proactive:
    "Proactively hunt for specific threat actors (APT29, Volt Typhoon, Scattered Spider) across telemetry, VirusTotal, Shodan, Censys. Search for IOCs and TTPs, correlate findings",
  threat_hunt_sector:
    "Track sector-specific attack patterns and hunt for threats targeting specific sectors. Monitor when actors shift sectors and generate sector-specific hunting queries",
  threat_hunt_anomaly:
    "AI-powered anomaly detection: detect living-off-the-land techniques, time-based anomalies, unusual command sequences, process injection, credential access patterns",
  vulnerability_instant_test:
    "Instant vulnerability testing: monitor CVE databases in real-time, generate exploit attempts immediately, test systems automatically, validate patches instantly. Respond to AI-accelerated attacks (100x faster)",
  attack_response_automated:
    "Automated attack response: detect attack patterns, automatically contain threats, generate incident reports, update threat models. Respond faster than human speed",
  session_status:
    "Show a /status-equivalent status card (usage + time + Reasoning/Verbose/Elevated); use for model-use questions (📊 session_status); optional per-session model override",
  image: "Analyze an image with the configured image model",
  memory_search: "Search memory files for relevant information",
  memory_get: "Retrieve specific lines from memory files",
};

/**
 * Canonical tool order for consistent prompt generation.
 * Tools are listed in logical groups for better organization.
 */
const TOOL_ORDER: readonly string[] = [
  // File operations
  "read",
  "write",
  "edit",
  "apply_patch",
  "grep",
  "find",
  "ls",
  // Execution
  "exec",
  "process",
  // Web
  "web_search",
  "web_fetch",
  "browser",
  // UI/Canvas
  "canvas",
  "nodes",
  // Scheduling
  "cron",
  // Communication
  "message",
  "gateway",
  // Session management
  "agents_list",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "subagents",
  "session_status",
  // Multi-agent
  "society_of_minds",
  // News/Content
  "news_aggregate",
  "news_sources",
  "news_fetch",
  "news_status",
  "content_rank",
  "content_cluster",
  "content_top",
  "seo_crosslink",
  "geo_check_ranking",
  "seo_optimize",
  // Enterprise
  "enterprise_workflow",
  "enterprise_approve",
  "enterprise_status",
  // Threat intelligence
  "threat_track_actor",
  "threat_add_ioc",
  "threat_search_ioc",
  "threat_list_campaigns",
  "threat_analyze_correlation",
  "credential_monitor",
  "threat_share_export",
  "threat_share_import",
  "threat_share_status",
  // Vulnerability management
  "vuln_track",
  "vuln_check",
  "vuln_patch_status",
  "vuln_exploit_detection",
  // Security assessment
  "security_assess_wintershield",
  "security_mitigate_wintershield",
  "infra_assess_ot",
  "infra_detect_prepositioning",
  "infra_resilience_plan",
  // AI threat
  "ai_threat_detect_anomaly",
  "ai_threat_respond",
  "ai_threat_hunt",
  // Penetration testing
  "pentest_recon",
  "pentest_exploit",
  "pentest_payload",
  "pentest_post_exploit",
  "pentest_report",
  "pentest_c2",
  "pentest_nmap",
  "pentest_metasploit",
  "pentest_burp",
  "pentest_shodan",
  "pentest_censys",
  "pentest_web_discover",
  "pentest_web_proxy",
  "pentest_web_xss",
  "pentest_web_sqli",
  "pentest_web_csrf",
  "pentest_web_https",
  "pentest_web_framework",
  // LLM security testing
  "llm_test_prompt_injection",
  "llm_test_indirect_injection",
  "llm_detect_injection",
  "llm_validate_data_boundaries",
  "llm_test_jailbreak",
  "llm_test_multi_turn",
  "llm_test_encoding_attacks",
  "llm_test_sycophancy",
  "llm_test_many_shot",
  "llm_test_rag_poisoning",
  "llm_detect_poisoned_retrieval",
  "llm_validate_rag_integrity",
  "llm_test_adversarial_seo",
  "llm_red_team_automated",
  "llm_generate_attack_scenarios",
  "llm_test_cognitive_dos",
  "llm_test_context_overflow",
  "llm_validate_guardrails",
  "llm_test_architectural_defenses",
  "llm_monitor_cot",
  "llm_validate_instruction_hierarchy",
  "llm_test_deliberative_alignment",
  // Cognitive security
  "cognitive_threat_detect",
  "decision_integrity_guard",
  "escalation_control",
  "context_provenance_track",
  "graceful_degradation_mode",
  "cognitive_resilience_simulate",
  "trust_trajectory_analyze",
  "decision_log",
  "ooda_loop_execute",
  // Adversary recommender
  "arr_generate_attacks",
  "arr_optimize_attack",
  "arr_evaluate_attack",
  "arr_rank_attacks",
  "arr_generate_test_pack",
  "arr_run_benchmark",
  "arr_compile_findings",
  // Swarm
  "swarm_orchestrate",
  "swarm_plan_red_team",
  "swarm_plan_blue_team",
  "swarm_consensus",
  "swarm_execute",
  "swarm_vs_swarm",
  "swarm_collaborate",
  "swarm_integrate_arr",
  "swarm_integrate_cognitive",
  // Defense operations
  "defense_siem_query",
  "defense_incident_response",
  "defense_threat_hunt",
  "defense_log_analysis",
  "defense_forensics",
  "defense_malware_analysis",
  "defense_splunk",
  "defense_elastic",
  "defense_sentinel",
  "defense_crowdstrike",
  "defense_misp",
  // Threat modeling
  "threat_model_extend",
  "red_team_automate",
  "threat_model_generate",
  "attack_scenario_generate",
  "vulnerability_driven_test",
  "red_team_from_intel",
  "threat_model_from_actor",
  "threat_hunt_proactive",
  "threat_hunt_sector",
  "threat_hunt_anomaly",
  "vulnerability_instant_test",
  "attack_response_automated",
  "sector_intelligence_track",
  // Memory
  "memory_search",
  "memory_get",
  // Media
  "image",
] as const;

/**
 * Processes and normalizes tool names, preserving original casing while deduplicating.
 */
function processToolNames(
  toolNames: string[] | undefined,
  toolSummaries: Record<string, string> | undefined,
): {
  availableTools: Set<string>;
  resolveToolName: (normalized: string) => string;
  toolLines: string[];
} {
  const rawToolNames = (toolNames ?? []).map((tool) => tool.trim());
  const canonicalToolNames = rawToolNames.filter(Boolean);

  // Preserve caller casing while deduping tool names by lowercase.
  const canonicalByNormalized = new Map<string, string>();
  for (const name of canonicalToolNames) {
    const normalized = name.toLowerCase();
    if (!canonicalByNormalized.has(normalized)) {
      canonicalByNormalized.set(normalized, name);
    }
  }

  const resolveToolName = (normalized: string) =>
    canonicalByNormalized.get(normalized) ?? normalized;

  const normalizedTools = canonicalToolNames.map((tool) => tool.toLowerCase());
  const availableTools = new Set(normalizedTools);

  // Process external tool summaries
  const externalToolSummaries = new Map<string, string>();
  for (const [key, value] of Object.entries(toolSummaries ?? {})) {
    const normalized = key.trim().toLowerCase();
    if (!normalized || !value?.trim()) {
      continue;
    }
    externalToolSummaries.set(normalized, value.trim());
  }

  // Build tool lines in canonical order, then add extras
  const extraTools = Array.from(
    new Set(normalizedTools.filter((tool) => !TOOL_ORDER.includes(tool))),
  );
  const enabledTools = TOOL_ORDER.filter((tool) => availableTools.has(tool));

  const toolLines = enabledTools.map((tool) => {
    const summary = CORE_TOOL_SUMMARIES[tool] ?? externalToolSummaries.get(tool);
    const name = resolveToolName(tool);
    return summary ? `- ${name}: ${summary}` : `- ${name}`;
  });

  for (const tool of extraTools.toSorted()) {
    const summary = CORE_TOOL_SUMMARIES[tool] ?? externalToolSummaries.get(tool);
    const name = resolveToolName(tool);
    toolLines.push(summary ? `- ${name}: ${summary}` : `- ${name}`);
  }

  return { availableTools, resolveToolName, toolLines };
}

/**
 * Builds the tooling section of the system prompt.
 * Documents available tools and their usage patterns.
 */
function buildToolingSection(
  toolLines: string[],
  execToolName: string,
  processToolName: string,
): string[] {
  const defaultToolLines =
    toolLines.length > 0
      ? toolLines.join("\n")
      : [
          "Pi lists the standard tools above. This runtime enables:",
          "- grep: search file contents for patterns",
          "- find: find files by glob pattern",
          "- ls: list directory contents",
          "- apply_patch: apply multi-file patches",
          `- ${execToolName}: run shell commands (supports background via yieldMs/background)`,
          `- ${processToolName}: manage background exec sessions`,
          "- browser: control OpenClaw's dedicated browser",
          "- canvas: present/eval/snapshot the Canvas",
          "- nodes: list/describe/notify/camera/screen on paired nodes",
          "- cron: manage cron jobs and wake events (use for reminders; when scheduling a reminder, write the systemEvent text as something that will read like a reminder when it fires, and mention that it is a reminder depending on the time gap between setting and firing; include recent context in reminder text if appropriate)",
          "- sessions_list: list sessions",
          "- sessions_history: fetch session history",
          "- sessions_send: send to another session",
          "- subagents: list/steer/kill sub-agent runs",
          '- session_status: show usage/time/model state and answer "what model are we using?"',
        ].join("\n");

  return [
    "## Tooling",
    "Tool availability (filtered by policy):",
    "Tool names are case-sensitive. Call tools exactly as listed.",
    defaultToolLines,
    "TOOLS.md does not control tool availability; it is user guidance for how to use external tools.",
    `For long waits, avoid rapid poll loops: use ${execToolName} with enough yieldMs or ${processToolName}(action=poll, timeout=<ms>).`,
    "If a task is more complex or takes longer, spawn a sub-agent. Completion is push-based: it will auto-announce when done.",
    "Do not poll `subagents list` / `sessions_list` in a loop; only check status on-demand (for intervention, debugging, or when explicitly asked).",
    "",
  ];
}

/**
 * Builds the tool call style section of the system prompt.
 * Documents when and how to narrate tool calls.
 */
function buildToolCallStyleSection(): string[] {
  return [
    "## Tool Call Style",
    "Default: do not narrate routine, low-risk tool calls (just call the tool).",
    "Narrate only when it helps: multi-step work, complex/challenging problems, sensitive actions (e.g., deletions), or when the user explicitly asks.",
    "Keep narration brief and value-dense; avoid repeating obvious steps.",
    "Use plain human language for narration unless in a technical context.",
    "",
  ];
}

/**
 * Builds the workspace section of the system prompt.
 * Documents workspace directory and file operation guidance.
 */
function buildWorkspaceSection(
  displayWorkspaceDir: string,
  workspaceGuidance: string,
  workspaceNotes: string[],
  userTimezone: string | undefined,
): string[] {
  const lines: string[] = [];

  if (userTimezone) {
    lines.push(
      "If you need the current date, time, or day of week, run session_status (📊 session_status).",
    );
  }

  lines.push(
    "## Workspace",
    `Your working directory is: ${displayWorkspaceDir}`,
    workspaceGuidance,
    ...workspaceNotes,
    "",
  );

  return lines;
}

/**
 * Builds the workspace files section of the system prompt.
 * Documents injected context files.
 */
function buildWorkspaceFilesSection(): string[] {
  return [
    "## Workspace Files (injected)",
    "These user-editable files are loaded by OpenClaw and included below in Project Context.",
    "",
  ];
}

/**
 * Builds the reasoning format section of the system prompt.
 * Documents required reasoning format when reasoning tags are enabled.
 */
function buildReasoningSection(reasoningHint: string | undefined): string[] {
  if (!reasoningHint) {
    return [];
  }
  return ["## Reasoning Format", reasoningHint, ""];
}

/**
 * Builds the runtime section of the system prompt.
 * Documents runtime environment details.
 */
function buildRuntimeSection(
  runtimeInfo:
    | {
        agentId?: string;
        host?: string;
        os?: string;
        arch?: string;
        node?: string;
        model?: string;
        defaultModel?: string;
        shell?: string;
        repoRoot?: string;
      }
    | undefined,
  runtimeChannel: string | undefined,
  runtimeCapabilities: string[],
  defaultThinkLevel: ThinkLevel | undefined,
  reasoningLevel: ReasoningLevel,
): string[] {
  return [
    "## Runtime",
    buildRuntimeLine(runtimeInfo, runtimeChannel, runtimeCapabilities, defaultThinkLevel),
    `Reasoning: ${reasoningLevel} (hidden unless on/stream). Toggle /reasoning; /status shows Reasoning when enabled.`,
  ];
}

/**
 * Main parameters for building the agent system prompt.
 */
export interface AgentSystemPromptParams {
  workspaceDir: string;
  defaultThinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  reasoningTagHint?: boolean;
  toolNames?: string[];
  toolSummaries?: Record<string, string>;
  modelAliasLines?: string[];
  userTimezone?: string;
  userTime?: string;
  userTimeFormat?: ResolvedTimeFormat;
  contextFiles?: EmbeddedContextFile[];
  skillsPrompt?: string;
  heartbeatPrompt?: string;
  docsPath?: string;
  workspaceNotes?: string[];
  ttsHint?: string;
  /** Controls which hardcoded sections to include. Defaults to "full". */
  promptMode?: PromptMode;
  runtimeInfo?: {
    agentId?: string;
    host?: string;
    os?: string;
    arch?: string;
    node?: string;
    model?: string;
    defaultModel?: string;
    shell?: string;
    channel?: string;
    capabilities?: string[];
    repoRoot?: string;
  };
  messageToolHints?: string[];
  sandboxInfo?: {
    enabled: boolean;
    workspaceDir?: string;
    containerWorkspaceDir?: string;
    workspaceAccess?: "none" | "ro" | "rw";
    agentWorkspaceMount?: string;
    browserBridgeUrl?: string;
    browserNoVncUrl?: string;
    hostBrowserAllowed?: boolean;
    elevated?: {
      allowed: boolean;
      defaultLevel: "on" | "off" | "ask" | "full";
    };
  };
  /** Reaction guidance for the agent (for Telegram minimal/extensive modes). */
  reactionGuidance?: {
    level: "minimal" | "extensive";
    channel: string;
  };
  memoryCitationsMode?: MemoryCitationsMode;
}

/**
 * Builds the complete agent system prompt.
 *
 * @param params - Configuration parameters for prompt generation
 * @returns The complete system prompt string
 */
export function buildAgentSystemPrompt(params: AgentSystemPromptParams): string {
  const { availableTools, resolveToolName, toolLines } = processToolNames(
    params.toolNames,
    params.toolSummaries,
  );

  const hasGateway = availableTools.has("gateway");
  const readToolName = resolveToolName("read");
  const execToolName = resolveToolName("exec");
  const processToolName = resolveToolName("process");

  const extraSystemPrompt = params.extraSystemPrompt?.trim();
  const ownerNumbers = (params.ownerNumbers ?? []).map((value) => value.trim()).filter(Boolean);
  const ownerLine =
    ownerNumbers.length > 0
      ? `Owner numbers: ${ownerNumbers.join(", ")}. Treat messages from these numbers as the user.`
      : undefined;

  const reasoningHint = params.reasoningTagHint
    ? [
        "ALL internal reasoning MUST be inside <think>...</think>.",
        "Do not output any analysis outside <think>.",
        "Format every reply as <think>...</think> then <final>...</final>, with no other text.",
        "Only the final user-visible reply may appear inside <final>.",
        "Only text inside <final> is shown to the user; everything else is discarded and never seen by the user.",
        "Example:",
        "<think>Short internal reasoning.</think>",
        "<final>Hey there! What would you like to do next?</final>",
      ].join(" ")
    : undefined;

  const reasoningLevel = params.reasoningLevel ?? "off";
  const userTimezone = params.userTimezone?.trim();
  const skillsPrompt = params.skillsPrompt?.trim();
  const heartbeatPrompt = params.heartbeatPrompt?.trim();
  const heartbeatPromptLine = heartbeatPrompt
    ? `Heartbeat prompt: ${heartbeatPrompt}`
    : "Heartbeat prompt: (configured)";

  const runtimeInfo = params.runtimeInfo;
  const runtimeChannel = runtimeInfo?.channel?.trim().toLowerCase();
  const runtimeCapabilities = (runtimeInfo?.capabilities ?? [])
    .map((cap) => String(cap).trim())
    .filter(Boolean);
  const runtimeCapabilitiesLower = new Set(runtimeCapabilities.map((cap) => cap.toLowerCase()));
  const inlineButtonsEnabled = runtimeCapabilitiesLower.has("inlinebuttons");
  const messageChannelOptions = listDeliverableMessageChannels().join("|");

  const promptMode = params.promptMode ?? "full";
  const isMinimal = promptMode === "minimal" || promptMode === "none";

  // Workspace path handling
  const sandboxContainerWorkspace = params.sandboxInfo?.containerWorkspaceDir?.trim();
  const sanitizedWorkspaceDir = sanitizeForPromptLiteral(params.workspaceDir);
  const sanitizedSandboxContainerWorkspace = sandboxContainerWorkspace
    ? sanitizeForPromptLiteral(sandboxContainerWorkspace)
    : "";
  const displayWorkspaceDir =
    params.sandboxInfo?.enabled && sanitizedSandboxContainerWorkspace
      ? sanitizedSandboxContainerWorkspace
      : sanitizedWorkspaceDir;
  const workspaceGuidance =
    params.sandboxInfo?.enabled && sanitizedSandboxContainerWorkspace
      ? `For read/write/edit/apply_patch, file paths resolve against host workspace: ${sanitizedWorkspaceDir}. For bash/exec commands, use sandbox container paths under ${sanitizedSandboxContainerWorkspace} (or relative paths from that workdir), not host paths. Prefer relative paths so both sandboxed exec and file tools work consistently.`
      : "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.";

  const workspaceNotes = (params.workspaceNotes ?? []).map((note) => note.trim()).filter(Boolean);

  // For "none" mode, return just the basic identity line
  if (promptMode === "none") {
    return "You are a personal assistant running inside OpenClaw.";
  }

  // Build all sections
  const lines: string[] = [
    "You are a personal assistant running inside OpenClaw.",
    "",
    ...buildToolingSection(toolLines, execToolName, processToolName),
    ...buildToolCallStyleSection(),
    ...buildSafetySection(),
    ...buildCliSection(),
    ...buildSkillsSection({ skillsPrompt, isMinimal, readToolName }),
    ...buildMemorySection({
      isMinimal,
      availableTools,
      citationsMode: params.memoryCitationsMode,
    }),
    ...buildSelfUpdateSection(hasGateway, isMinimal),
    ...buildModelAliasesSection(params.modelAliasLines, isMinimal),
    ...buildWorkspaceSection(displayWorkspaceDir, workspaceGuidance, workspaceNotes, userTimezone),
    ...buildDocsSection({ docsPath: params.docsPath, isMinimal, readToolName }),
    ...buildSandboxSection(params.sandboxInfo),
    ...buildUserIdentitySection(ownerLine, isMinimal),
    ...buildTimeSection({ userTimezone }),
    ...buildWorkspaceFilesSection(),
    ...buildReplyTagsSection(isMinimal),
    ...buildMessagingSection({
      isMinimal,
      availableTools,
      messageChannelOptions,
      inlineButtonsEnabled,
      runtimeChannel,
      messageToolHints: params.messageToolHints,
    }),
    ...buildVoiceSection({ isMinimal, ttsHint: params.ttsHint }),
  ];

  // Add extra system prompt if provided
  if (extraSystemPrompt) {
    const contextHeader =
      promptMode === "minimal" ? "## Subagent Context" : "## Group Chat Context";
    lines.push(contextHeader, extraSystemPrompt, "");
  }

  // Add reactions section
  lines.push(...buildReactionsSection(params.reactionGuidance));

  // Add reasoning section
  lines.push(...buildReasoningSection(reasoningHint));

  // Add project context
  lines.push(...buildProjectContextSection(params.contextFiles ?? []));

  // Add silent replies section
  lines.push(...buildSilentRepliesSection(isMinimal));

  // Add heartbeats section
  lines.push(...buildHeartbeatsSection(heartbeatPromptLine, isMinimal));

  // Add runtime section
  lines.push(
    ...buildRuntimeSection(
      runtimeInfo,
      runtimeChannel,
      runtimeCapabilities,
      params.defaultThinkLevel,
      reasoningLevel,
    ),
  );

  return lines.filter(Boolean).join("\n");
}

/**
 * Builds the runtime information line for the system prompt.
 *
 * @param runtimeInfo - Runtime environment information
 * @param runtimeChannel - Current messaging channel
 * @param runtimeCapabilities - Available channel capabilities
 * @param defaultThinkLevel - Default thinking level
 * @returns Formatted runtime information string
 */
export function buildRuntimeLine(
  runtimeInfo?: {
    agentId?: string;
    host?: string;
    os?: string;
    arch?: string;
    node?: string;
    model?: string;
    defaultModel?: string;
    shell?: string;
    repoRoot?: string;
  },
  runtimeChannel?: string,
  runtimeCapabilities: string[] = [],
  defaultThinkLevel?: ThinkLevel,
): string {
  const parts: string[] = [];

  if (runtimeInfo?.agentId) {
    parts.push(`agent=${runtimeInfo.agentId}`);
  }
  if (runtimeInfo?.host) {
    parts.push(`host=${runtimeInfo.host}`);
  }
  if (runtimeInfo?.repoRoot) {
    parts.push(`repo=${runtimeInfo.repoRoot}`);
  }
  if (runtimeInfo?.os) {
    const archSuffix = runtimeInfo?.arch ? ` (${runtimeInfo.arch})` : "";
    parts.push(`os=${runtimeInfo.os}${archSuffix}`);
  } else if (runtimeInfo?.arch) {
    parts.push(`arch=${runtimeInfo.arch}`);
  }
  if (runtimeInfo?.node) {
    parts.push(`node=${runtimeInfo.node}`);
  }
  if (runtimeInfo?.model) {
    parts.push(`model=${runtimeInfo.model}`);
  }
  if (runtimeInfo?.defaultModel) {
    parts.push(`default_model=${runtimeInfo.defaultModel}`);
  }
  if (runtimeInfo?.shell) {
    parts.push(`shell=${runtimeInfo.shell}`);
  }
  if (runtimeChannel) {
    parts.push(`channel=${runtimeChannel}`);
    const capStr = runtimeCapabilities.length > 0 ? runtimeCapabilities.join(",") : "none";
    parts.push(`capabilities=${capStr}`);
  }
  parts.push(`thinking=${defaultThinkLevel ?? "off"}`);

  return `Runtime: ${parts.join(" | ")}`;
}
