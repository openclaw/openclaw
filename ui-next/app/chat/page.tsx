"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { formatRelativeTimestamp } from "@/lib/format";
import type { GatewayEventFrame } from "@/lib/gateway";
import type {
  SessionsListResult,
  GatewaySessionRow,
  ModelChoice,
  ModelsListResult,
  SessionsPatchResult,
} from "@/lib/types";
import { useGateway, useGatewayEvents } from "@/lib/use-gateway";

// ============================================
// Types
// ============================================

type ChatMessage = {
  idempotencyKey?: string; // Optional key to prevent duplicate messages
  role: "user" | "assistant" | "system";
  content: string | { type: string; text: string; thinking?: string }[];
  timestamp?: number;
};

type ChatHistoryResult = {
  sessionKey: string;
  messages: ChatMessage[];
  thinkingLevel?: string;
};

type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

// ============================================
// Command Types
// ============================================

type ParsedCommand = {
  name: string;
  args: string;
};

type CommandHandler = (args: string) => Promise<void>;

// ============================================
// Styles
// ============================================

const styles = {
  layout: {
    display: "grid",
    gap: 20,
    minHeight: 500,
  } as React.CSSProperties,
  sidebar: {
    background: "var(--card)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: 16,
    display: "flex",
    flexDirection: "column" as const,
    gap: 12,
  } as React.CSSProperties,
  card: {
    background: "var(--card)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-lg)",
    display: "flex",
    flexDirection: "column" as const,
    height: 500,
  } as React.CSSProperties,
  cardTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--text-strong)",
    margin: 0,
  } as React.CSSProperties,
  cardSub: {
    fontSize: 12,
    color: "var(--muted)",
    marginTop: 2,
  } as React.CSSProperties,
  btn: {
    height: 28,
    padding: "0 12px",
    fontSize: 12,
    fontWeight: 500,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--secondary)",
    color: "var(--text)",
    cursor: "pointer",
    width: "100%",
  } as React.CSSProperties,
  btnPrimary: {
    background: "var(--accent)",
    color: "#fff",
    borderColor: "var(--accent)",
  } as React.CSSProperties,
  sessionList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
    flex: 1,
    overflow: "auto",
    marginTop: 8,
  } as React.CSSProperties,
  sessionRow: {
    padding: "8px 10px",
    borderRadius: "var(--radius-md)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    background: "transparent",
    cursor: "pointer",
    textAlign: "left" as const,
    width: "100%",
    transition: "background 0.15s, border-color 0.15s",
  } as React.CSSProperties,
  sessionRowActive: {
    background: "var(--bg-hover)",
    borderColor: "var(--border)",
  } as React.CSSProperties,
  sessionTitle: {
    fontSize: 13,
    fontWeight: 500,
    color: "var(--text-strong)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  sessionSub: {
    fontSize: 11,
    color: "var(--muted)",
    marginTop: 2,
  } as React.CSSProperties,
  messagesArea: {
    flex: 1,
    overflow: "auto",
    padding: 16,
    display: "flex",
    flexDirection: "column" as const,
    gap: 12,
  } as React.CSSProperties,
  messageRow: {
    display: "flex",
    flexDirection: "column" as const,
    maxWidth: "80%",
    gap: 4,
  } as React.CSSProperties,
  messageRowUser: {
    alignSelf: "flex-end",
    alignItems: "flex-end",
  } as React.CSSProperties,
  messageRowAssistant: {
    alignSelf: "flex-start",
    alignItems: "flex-start",
  } as React.CSSProperties,
  bubble: {
    padding: "10px 14px",
    borderRadius: "var(--radius-lg)",
    fontSize: 14,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
  } as React.CSSProperties,
  bubbleUser: {
    background: "var(--accent)",
    color: "#fff",
    borderBottomRightRadius: 4,
  } as React.CSSProperties,
  bubbleAssistant: {
    background: "var(--bg-hover)",
    color: "var(--text)",
    borderBottomLeftRadius: 4,
  } as React.CSSProperties,
  timestamp: {
    fontSize: 10,
    color: "var(--muted)",
  } as React.CSSProperties,
  compose: {
    padding: 16,
    borderTop: "1px solid var(--border)",
    display: "flex",
    gap: 8,
  } as React.CSSProperties,
  input: {
    flex: 1,
    minHeight: 38,
    padding: "8px 12px",
    fontSize: 14,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--bg)",
    color: "var(--text)",
    outline: "none",
    resize: "none" as const,
    fontFamily: "inherit",
  } as React.CSSProperties,
  muted: {
    color: "var(--muted)",
    fontSize: 13,
  } as React.CSSProperties,
  callout: {
    padding: "10px 14px",
    borderRadius: "var(--radius-md)",
    fontSize: 13,
    margin: 16,
  } as React.CSSProperties,
  calloutDanger: {
    background: "var(--danger-subtle)",
    color: "var(--danger)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--danger)",
  } as React.CSSProperties,
  emptyState: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--muted)",
    fontSize: 14,
  } as React.CSSProperties,
  modelSelect: {
    height: 28,
    padding: "0 10px",
    fontSize: 12,
    fontWeight: 500,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--card)",
    color: "var(--text)",
    cursor: "pointer",
    minWidth: 180,
    maxWidth: 280,
  } as React.CSSProperties,
  modelBadge: {
    padding: "4px 8px",
    fontSize: 11,
    fontWeight: 600,
    borderRadius: "var(--radius-md)",
    background: "var(--accent-subtle)",
    color: "var(--accent)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--accent)",
  } as React.CSSProperties,
  thinkingBlock: {
    marginTop: 4,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    overflow: "hidden",
  } as React.CSSProperties,
  thinkingHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    background: "var(--secondary)",
    cursor: "pointer",
    userSelect: "none" as const,
    fontSize: 11,
    fontWeight: 600,
    color: "var(--muted)",
  } as React.CSSProperties,
  thinkingContent: {
    padding: "8px 12px",
    background: "var(--bg)",
    fontSize: 12,
    lineHeight: 1.6,
    color: "var(--text)",
    whiteSpace: "pre-wrap" as const,
  } as React.CSSProperties,
  codeBlock: {
    marginTop: 8,
    borderRadius: "var(--radius-md)",
    overflow: "hidden",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
  } as React.CSSProperties,
  codeHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 12px",
    background: "var(--secondary)",
    borderBottom: "1px solid var(--border)",
    fontSize: 11,
    fontWeight: 600,
    color: "var(--muted)",
  } as React.CSSProperties,
  codeLanguage: {
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  } as React.CSSProperties,
  copyBtn: {
    background: "transparent",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-sm)",
    padding: "2px 8px",
    fontSize: 10,
    color: "var(--text)",
    cursor: "pointer",
  } as React.CSSProperties,
  expandBtn: {
    background: "var(--accent)",
    borderWidth: 0,
    borderRadius: "var(--radius-sm)",
    padding: "6px 16px",
    fontSize: 12,
    fontWeight: 600,
    color: "#fff",
    cursor: "pointer",
    marginTop: 8,
  } as React.CSSProperties,
  partialCodeContainer: {
    position: "relative" as const,
    overflow: "hidden",
  } as React.CSSProperties,
  codeFadeOverlay: {
    position: "absolute" as const,
    bottom: 0,
    left: 0,
    right: 0,
    height: 80,
    background: "linear-gradient(to bottom, transparent, var(--bg))",
    pointerEvents: "none" as const,
  } as React.CSSProperties,
  autocomplete: {
    position: "absolute" as const,
    bottom: "100%",
    left: 0,
    right: 0,
    marginBottom: 8,
    maxHeight: 200,
    overflow: "auto",
    background: "var(--card)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
    zIndex: 10,
  } as React.CSSProperties,
  autocompleteItem: {
    padding: "8px 12px",
    fontSize: 13,
    cursor: "pointer",
    background: "transparent",
    borderWidth: 0,
    borderBottom: "1px solid var(--border)",
    width: "100%",
    textAlign: "left" as const,
    color: "var(--text)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  } as React.CSSProperties,
  autocompleteItemHover: {
    background: "var(--bg-hover)",
  } as React.CSSProperties,
  autocompleteDescription: {
    fontSize: 11,
    color: "var(--muted)",
    marginLeft: 8,
  } as React.CSSProperties,
};

// ============================================
// Command Parser
// ============================================

const COMMAND_ALIASES: Record<string, string> = {
  elev: "elevated",
};

const COMMAND_DEFINITIONS: Array<{ name: string; description: string }> = [
  { name: "help", description: "Show slash command help" },
  { name: "status", description: "Show gateway status summary" },
  { name: "agent", description: "Switch agent" },
  { name: "session", description: "Switch session" },
  { name: "model", description: "Set AI model" },
  { name: "think", description: "Set thinking level" },
  { name: "verbose", description: "Toggle verbose mode" },
  { name: "reasoning", description: "Toggle reasoning" },
  { name: "usage", description: "Toggle usage footer" },
  { name: "elevated", description: "Set elevated mode" },
  { name: "new", description: "Reset session" },
  { name: "reset", description: "Reset session" },
  { name: "abort", description: "Abort active run" },
];

function parseCommand(input: string): ParsedCommand {
  const trimmed = input.replace(/^\//, "").trim();
  if (!trimmed) {
    return { name: "", args: "" };
  }
  const [name, ...rest] = trimmed.split(/\s+/);
  const normalized = name.toLowerCase();
  return {
    name: COMMAND_ALIASES[normalized] ?? normalized,
    args: rest.join(" ").trim(),
  };
}

function getCommandCompletions(partial: string) {
  const query = partial.toLowerCase();
  return COMMAND_DEFINITIONS.filter((cmd) => cmd.name.startsWith(query));
}

// ============================================
// Message Component
// ============================================

function detectLanguage(code: string): string {
  // Try to detect language from common patterns
  const trimmed = code.trim();

  // Check for shebang
  if (trimmed.startsWith("#!")) {
    if (trimmed.includes("python")) {
      return "python";
    }
    if (trimmed.includes("node") || trimmed.includes("nodejs")) {
      return "javascript";
    }
    if (trimmed.includes("bash") || trimmed.includes("sh")) {
      return "bash";
    }
  }

  // Check for common patterns
  if (trimmed.startsWith("<?php")) {
    return "php";
  }
  if (trimmed.startsWith("<!DOCTYPE html") || trimmed.startsWith("<html")) {
    return "html";
  }
  if (trimmed.startsWith("{") && trimmed.includes('"')) {
    return "json";
  }
  if (
    trimmed.startsWith("package ") ||
    trimmed.startsWith("import ") ||
    trimmed.startsWith("public class")
  ) {
    return "java";
  }
  if (
    trimmed.startsWith("func ") ||
    trimmed.startsWith("package ") ||
    trimmed.startsWith("var ") ||
    trimmed.startsWith("const ")
  ) {
    return "go";
  }
  if (
    trimmed.startsWith("import ") ||
    trimmed.startsWith("from ") ||
    trimmed.startsWith("class ") ||
    trimmed.startsWith("def ")
  ) {
    return "python";
  }
  if (
    trimmed.startsWith("function ") ||
    trimmed.startsWith("const ") ||
    trimmed.startsWith("let ") ||
    trimmed.startsWith("var ") ||
    trimmed.startsWith("console.")
  ) {
    return "javascript";
  }
  if (
    trimmed.startsWith("fn ") ||
    trimmed.startsWith("let ") ||
    trimmed.startsWith("const ") ||
    trimmed.startsWith("pub fn")
  ) {
    return "rust";
  }
  if (
    trimmed.startsWith("module ") ||
    trimmed.startsWith("import ") ||
    trimmed.startsWith("def ")
  ) {
    return "ruby";
  }
  if (
    trimmed.startsWith("using ") ||
    trimmed.startsWith("namespace ") ||
    trimmed.startsWith("class ") ||
    trimmed.startsWith("public ")
  ) {
    return "csharp";
  }
  if (
    trimmed.startsWith("import ") ||
    trimmed.startsWith("class ") ||
    trimmed.startsWith("fun ") ||
    trimmed.startsWith("val ") ||
    trimmed.startsWith("var ")
  ) {
    return "kotlin";
  }
  if (
    trimmed.startsWith("import ") ||
    trimmed.startsWith("class ") ||
    trimmed.startsWith("fun ") ||
    trimmed.startsWith("package ")
  ) {
    return "kotlin";
  }
  if (
    trimmed.startsWith("library ") ||
    trimmed.startsWith("import ") ||
    trimmed.startsWith("class ") ||
    trimmed.startsWith("fun ")
  ) {
    return "kotlin";
  }
  if (
    trimmed.startsWith("void ") ||
    trimmed.startsWith("int ") ||
    trimmed.startsWith("string ") ||
    trimmed.startsWith("#include")
  ) {
    return "cpp";
  }
  if (
    trimmed.startsWith("#include") ||
    trimmed.startsWith("int main") ||
    trimmed.startsWith("void ")
  ) {
    return "c";
  }
  if (
    trimmed.startsWith("import ") ||
    trimmed.startsWith("class ") ||
    trimmed.startsWith("def ") ||
    trimmed.startsWith("print ")
  ) {
    return "python";
  }

  // Check for Dart patterns
  if (
    trimmed.includes("void main()") ||
    (trimmed.includes("class ") && trimmed.includes("Widget")) ||
    trimmed.startsWith("import 'package:")
  ) {
    return "dart";
  }

  return "";
}

function parseContentWithCode(content: string): React.ReactNode[] {
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  const elements: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    // Add text before code block
    if (match.index > lastIndex) {
      const textBefore = content.slice(lastIndex, match.index);
      if (textBefore.trim()) {
        elements.push(<span key={`text-${lastIndex}`}>{textBefore}</span>);
      }
    }

    const language = match[1] || detectLanguage(match[2]);
    const code = match[2].trim();

    elements.push(<CodeBlock key={`code-${match.index}`} language={language} code={code} />);

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < content.length) {
    const textAfter = content.slice(lastIndex);
    if (textAfter.trim()) {
      elements.push(<span key={`text-${lastIndex}`}>{textAfter}</span>);
    }
  }

  return elements;
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const MAX_LINES = 20; // Show partial if more than this
  const codeLines = code.split("\n");
  const isLong = codeLines.length > MAX_LINES;
  const displayCode = expanded || !isLong ? code : codeLines.slice(0, MAX_LINES).join("\n");

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const displayLanguage = language || "code";

  return (
    <div style={styles.codeBlock}>
      <div style={styles.codeHeader}>
        <span style={styles.codeLanguage}>{displayLanguage}</span>
        <div style={{ display: "flex", gap: 6 }}>
          {isLong && !expanded && (
            <span style={{ fontSize: 10, color: "var(--muted)", alignSelf: "center" }}>
              {codeLines.length} lines
            </span>
          )}
          <button style={styles.copyBtn} onClick={handleCopy} title="Copy code">
            {copied ? "✓ Copied" : "📋 Copy"}
          </button>
        </div>
      </div>
      <div style={isLong && !expanded ? styles.partialCodeContainer : {}}>
        <SyntaxHighlighter
          language={language || "plaintext"}
          style={vscDarkPlus}
          customStyle={{
            margin: 0,
            padding: 12,
            background: "var(--bg)",
            fontSize: 12,
            lineHeight: 1.6,
            borderRadius: 0,
          }}
          showLineNumbers
          wrapLines
        >
          {displayCode}
        </SyntaxHighlighter>
        {isLong && !expanded && (
          <>
            <div style={styles.codeFadeOverlay} />
            <div style={{ padding: "8px 12px", textAlign: "center" as const }}>
              <button style={styles.expandBtn} onClick={() => setExpanded(true)}>
                Show Full Code ({codeLines.length - MAX_LINES} more lines)
              </button>
            </div>
          </>
        )}
      </div>
      {expanded && isLong && (
        <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)" }}>
          <button
            style={{ ...styles.btn, background: "var(--secondary)" }}
            onClick={() => setExpanded(false)}
          >
            ▲ Show Less
          </button>
        </div>
      )}
    </div>
  );
}

function Message({ message }: { message: ChatMessage }) {
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  let contentToRender: React.ReactNode;
  let thinkingContent: React.ReactNode = null;

  if (typeof message.content === "string") {
    contentToRender = parseContentWithCode(message.content);
  } else if (message.content && typeof message.content === "object") {
    if (Array.isArray(message.content) && message.content.length > 0) {
      const textParts: React.ReactNode[] = [];
      const thinkingParts: React.ReactNode[] = [];

      message.content.forEach((part, idx) => {
        if (part.type === "text") {
          textParts.push(<span key={idx}>{parseContentWithCode(part.text)}</span>);
        }
        if (part.type === "thinking" && part.thinking) {
          thinkingParts.push(
            <div key={idx}>
              <div
                style={styles.thinkingHeader}
                onClick={() => setThinkingExpanded(!thinkingExpanded)}
                title={thinkingExpanded ? "Collapse" : "Expand"}
              >
                <span
                  style={{
                    transition: "transform 0.2s",
                    display: "inline-block",
                    transform: thinkingExpanded ? "rotate(90deg)" : "rotate(0deg)",
                  }}
                >
                  ▶
                </span>
                <span>
                  Thinking {thinkingExpanded ? "(click to collapse)" : "(click to expand)"}
                </span>
              </div>
              {thinkingExpanded && <div style={styles.thinkingContent}>{part.thinking}</div>}
            </div>,
          );
        }
      });

      contentToRender = textParts.length > 0 ? textParts : null;
      thinkingContent = thinkingParts.length > 0 ? thinkingParts : null;
    } else {
      contentToRender = "";
    }
  }

  // System messages have a different style
  if (isSystem) {
    return (
      <div
        style={{
          ...styles.messageRow,
          alignSelf: "center",
          maxWidth: "90%",
        }}
      >
        <div
          style={{
            ...styles.bubble,
            background: "var(--secondary)",
            color: "var(--muted)",
            fontSize: 12,
            fontFamily: "monospace",
            borderBottomLeftRadius: 4,
            borderBottomRightRadius: 4,
          }}
        >
          {contentToRender}
        </div>
        {message.timestamp && (
          <div style={styles.timestamp}>{formatRelativeTimestamp(message.timestamp)}</div>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        ...styles.messageRow,
        ...(isUser ? styles.messageRowUser : styles.messageRowAssistant),
      }}
    >
      <div
        style={{
          ...styles.bubble,
          ...(isUser ? styles.bubbleUser : styles.bubbleAssistant),
        }}
      >
        {thinkingContent}
        {contentToRender}
      </div>
      {message.timestamp && (
        <div style={styles.timestamp}>{formatRelativeTimestamp(message.timestamp)}</div>
      )}
    </div>
  );
}

// ============================================
// Main Chat Page
// ============================================

export default function ChatPage() {
  const { state, request, client } = useGateway();
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<GatewaySessionRow[]>([]);
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatStream, setChatStream] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [commandPrefix, setCommandPrefix] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const selectedSessionKeyRef = useRef<string | null>(null);
  selectedSessionKeyRef.current = selectedSessionKey;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const loadSessions = useCallback(async () => {
    if (state !== "connected") {
      return;
    }

    try {
      const res = await request<SessionsListResult>("sessions.list", {});
      setSessions(res.sessions ?? []);
      // Auto-select first session if none selected
      if (!selectedSessionKey && res.sessions?.length) {
        setSelectedSessionKey(res.sessions[0].key);
      }
    } catch (err) {
      console.error("Failed to load sessions:", err);
    }
  }, [state, request, selectedSessionKey]);

  const loadModels = useCallback(async () => {
    if (state !== "connected") {
      return;
    }

    setModelsLoading(true);
    try {
      const res = await request<ModelsListResult>("models.list", {});
      setModels(res.models ?? []);
    } catch (err) {
      console.error("Failed to load models:", err);
    } finally {
      setModelsLoading(false);
    }
  }, [state, request]);

  const loadChatHistory = useCallback(async () => {
    // Read from ref to always use the LATEST session key (avoids stale closure)
    const sessionKey = selectedSessionKeyRef.current;
    if (state !== "connected" || !sessionKey) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await request<ChatHistoryResult>("chat.history", {
        sessionKey,
      });
      // Only update if session hasn't changed while we were fetching
      if (selectedSessionKeyRef.current === sessionKey) {
        setMessages(res.messages ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load chat history");
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, [state, request]);

  // ============================================
  // Command Handlers
  // ============================================

  const addSystemMessage = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      {
        role: "system",
        content,
        timestamp: Date.now(),
      },
    ]);
  }, []);

  const handleCommand = useCallback(
    async (raw: string) => {
      const { name, args } = parseCommand(raw);
      if (!name) {
        return false;
      }

      const addSystem = (content: string) => {
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content,
            timestamp: Date.now(),
          },
        ]);
      };

      try {
        switch (name) {
          case "help": {
            const helpText = [
              "Slash commands:",
              "/help - Show this help",
              "/status - Show gateway status",
              "/agent <id> - Switch agent",
              "/session <key> - Switch session",
              "/model <provider/model> - Set model",
              "/think <level> - Set thinking level",
              "/verbose <on|off> - Toggle verbose",
              "/reasoning <on|off> - Toggle reasoning",
              "/usage <off|tokens|full> - Toggle usage footer",
              "/elevated <on|off|ask|full> - Set elevated mode",
              "/new or /reset - Reset session",
              "/abort - Abort active run",
            ].join("\n");
            addSystem(helpText);
            break;
          }

          case "new":
          case "reset": {
            const newKey = `agent:main:${new Date().getTime()}`;
            const res = await request<{ key: string }>("sessions.reset", { key: newKey });
            if (res.key) {
              setMessages([]);
              setChatStream(null);
              setError(null);
              setSelectedSessionKey(res.key);
              addSystem(`Session reset: ${res.key}`);
              void loadSessions();
            }
            break;
          }

          case "model": {
            if (!args) {
              addSystem(`Current model: ${currentModel || "default"}`);
              addSystem("Usage: /model <provider/model>");
              break;
            }
            if (!selectedSessionKey) {
              addSystem("No session selected");
              break;
            }
            const result = await request<SessionsPatchResult>("sessions.patch", {
              key: selectedSessionKey,
              model: args,
            });
            if (result.resolved) {
              setCurrentModel(`${result.resolved.modelProvider}/${result.resolved.model}`);
              addSystem(`Model set to ${result.resolved.modelProvider}/${result.resolved.model}`);
            } else {
              setCurrentModel(args);
              addSystem(`Model set to ${args}`);
            }
            void loadSessions();
            break;
          }

          case "think": {
            if (!args) {
              addSystem("Usage: /think <level>");
              addSystem("Levels: low, medium, high, ultra (varies by model)");
              break;
            }
            if (!selectedSessionKey) {
              addSystem("No session selected");
              break;
            }
            const result = await request<SessionsPatchResult>("sessions.patch", {
              key: selectedSessionKey,
              thinkingLevel: args,
            });
            addSystem(`Thinking level set to ${args}`);
            if (result.resolved?.thinkingLevel) {
              addSystem(`Applied: ${result.resolved.thinkingLevel}`);
            }
            break;
          }

          case "verbose": {
            if (!args || !["on", "off"].includes(args.toLowerCase())) {
              addSystem("Usage: /verbose <on|off>");
              break;
            }
            if (!selectedSessionKey) {
              addSystem("No session selected");
              break;
            }
            const result = await request<SessionsPatchResult>("sessions.patch", {
              key: selectedSessionKey,
              verboseLevel: args.toLowerCase(),
            });
            addSystem(`Verbose set to ${args.toLowerCase()}`);
            break;
          }

          case "reasoning": {
            if (!args || !["on", "off"].includes(args.toLowerCase())) {
              addSystem("Usage: /reasoning <on|off>");
              break;
            }
            if (!selectedSessionKey) {
              addSystem("No session selected");
              break;
            }
            const result = await request<SessionsPatchResult>("sessions.patch", {
              key: selectedSessionKey,
              reasoningLevel: args.toLowerCase(),
            });
            addSystem(`Reasoning set to ${args.toLowerCase()}`);
            break;
          }

          case "usage": {
            if (!args || !["off", "tokens", "full"].includes(args.toLowerCase())) {
              addSystem("Usage: /usage <off|tokens|full>");
              break;
            }
            if (!selectedSessionKey) {
              addSystem("No session selected");
              break;
            }
            const result = await request<SessionsPatchResult>("sessions.patch", {
              key: selectedSessionKey,
              responseUsage: args.toLowerCase() === "off" ? null : (args.toLowerCase() as "tokens" | "full"),
            });
            addSystem(`Usage footer set to ${args.toLowerCase()}`);
            break;
          }

          case "elevated":
          case "elev": {
            if (!args || !["on", "off", "ask", "full"].includes(args.toLowerCase())) {
              addSystem("Usage: /elevated <on|off|ask|full>");
              break;
            }
            if (!selectedSessionKey) {
              addSystem("No session selected");
              break;
            }
            const result = await request<SessionsPatchResult>("sessions.patch", {
              key: selectedSessionKey,
              elevatedLevel: args.toLowerCase(),
            });
            addSystem(`Elevated mode set to ${args.toLowerCase()}`);
            break;
          }

          case "status": {
            try {
              const status = await request<Record<string, unknown>>("gateway.status", {});
              const lines = [
                "Gateway Status:",
                `Connected: ${state}`,
                `Sessions: ${sessions.length}`,
                `Model: ${currentModel || "default"}`,
              ];
              if (status && typeof status === "object") {
                if (typeof status.gateway === "string") {
                  lines.push(`Gateway: ${status.gateway}`);
                }
                if (typeof status.version === "string") {
                  lines.push(`Version: ${status.version}`);
                }
              }
              addSystem(lines.join("\n"));
            } catch (err) {
              addSystem(`Status check failed: ${err instanceof Error ? err.message : "unknown error"}`);
            }
            break;
          }

          case "abort": {
            if (!selectedSessionKey) {
              addSystem("No session selected");
              break;
            }
            try {
              await request("chat.abort", { sessionKey: selectedSessionKey });
              addSystem("Run aborted");
            } catch (err) {
              addSystem(`Abort failed: ${err instanceof Error ? err.message : "unknown error"}`);
            }
            break;
          }

          case "session": {
            if (!args) {
              addSystem(`Current session: ${selectedSessionKey || "none"}`);
              addSystem("Usage: /session <session-key>");
              addSystem(`Available sessions: ${sessions.map((s) => s.key).join(", ")}`);
              break;
            }
            setSelectedSessionKey(args);
            setMessages([]);
            setChatStream(null);
            setError(null);
            addSystem(`Session switched to ${args}`);
            void loadChatHistory();
            break;
          }

          case "agent": {
            if (!args) {
              addSystem(`Current agent: agent:main`);
              addSystem("Usage: /agent <agent-id>");
              break;
            }
            // Agent switching would require agent management - for now just inform
            addSystem(`Agent switch requested: ${args}`);
            addSystem("Note: Agent switching requires session reset to take effect");
            break;
          }

          default:
            // Unknown command - let it be sent as a message
            return false;
        }
        return true;
      } catch (err) {
        addSystem(`Command failed: ${err instanceof Error ? err.message : "unknown error"}`);
        return true;
      }
    },
    [state, request, selectedSessionKey, currentModel, sessions, loadSessions, loadChatHistory],
  );

  // ============================================
  // Send Message & Model Change
  // ============================================

  const sendMessage = useCallback(async () => {
    if (!draft.trim() || !selectedSessionKey || state !== "connected") {
      return;
    }

    const text = draft.trim();
    setDraft("");

    // Check if it's a command (starts with /)
    if (text.startsWith("/")) {
      const handled = await handleCommand(text);
      if (handled) {
        return;
      }
      // If command not recognized, fall through to send as message
    }

    setSending(true);
    setError(null);
    setChatStream("");

    // Optimistically add user message
    const userMessage: ChatMessage = {
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMessage]);

    try {
      // chat.send only acknowledges receipt — actual response comes via "chat" events
      await request("chat.send", {
        sessionKey: selectedSessionKey,
        message: text,
        deliver: false,
        idempotencyKey: crypto.randomUUID(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
      setChatStream(null);
    } finally {
      setSending(false);
    }
  }, [draft, selectedSessionKey, state, request, handleCommand]);

  // ============================================
  // Clear Chat (Reset messages, keep session)
  // ============================================

  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const handleClearChat = useCallback(() => {
    setShowClearConfirm(true);
  }, []);

  const confirmClearChat = useCallback(async () => {
    if (!selectedSessionKey) return;

    try {
      // Clear local messages
      setMessages([]);
      setChatStream(null);
      setError(null);
      setShowClearConfirm(false);

      // Optional: Send a system message to indicate chat was cleared
      // (commented out - can be enabled if desired)
      // setMessages([{ role: "system", content: "Chat history cleared", timestamp: Date.now() }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear chat");
      setShowClearConfirm(false);
    }
  }, [selectedSessionKey]);

  const changeModel = useCallback(
    async (modelId: string) => {
      if (!selectedSessionKey || state !== "connected") {
        return;
      }

      try {
        const result = await request<SessionsPatchResult>("sessions.patch", {
          key: selectedSessionKey,
          model: modelId || null,
        });
        // Update current model from the resolved response
        if (result.resolved) {
          setCurrentModel(`${result.resolved.modelProvider}/${result.resolved.model}`);
        } else {
          setCurrentModel(modelId || null);
        }
        // Reload sessions to update the session list with new model info
        void loadSessions();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to change model");
      }
    },
    [selectedSessionKey, state, request, loadSessions],
  );

  // Listen for real-time "chat" events from the gateway
  useGatewayEvents(client, (evt: GatewayEventFrame) => {
    if (evt.event !== "chat") {
      return;
    }

    const payload = evt.payload as ChatEventPayload | undefined;
    if (!payload) {
      return;
    }

    // Only process events for the currently selected session
    const currentSessionKey = selectedSessionKeyRef.current;
    if (payload.sessionKey !== currentSessionKey) {
      return;
    }

    if (payload.state === "delta") {
      // Streaming text delta — accumulate into chatStream
      const msg = payload.message as Record<string, unknown> | undefined;
      const content = msg?.content;
      let delta = "";
      if (typeof content === "string") {
        delta = content;
      } else if (Array.isArray(content)) {
        delta = (content as Array<{ type: string; text?: string }>)
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("");
      } else if (typeof msg?.text === "string") {
        delta = msg.text;
      }
      if (typeof delta === "string") {
        setChatStream((prev) =>
          // Gateway sends cumulative text — use it directly if longer
          delta.length >= (prev?.length ?? 0) ? delta : prev,
        );
      }
    } else if (payload.state === "final") {
      // Final message — commit to messages list, clear stream
      const msg = payload.message as Record<string, unknown> | undefined;
      if (msg) {
        const finalMsg: ChatMessage = {
          role: "assistant",
          content:
            typeof msg.content === "string"
              ? msg.content
              : Array.isArray(msg.content)
                ? (msg.content as Array<{ type: string; text: string }>)
                : typeof msg.text === "string"
                  ? msg.text
                  : "",
          timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
        };
        setMessages((prev) => [...prev, finalMsg]);
      }
      setChatStream(null);
    } else if (payload.state === "aborted") {
      // Aborted — if we had streamed text, save it
      setChatStream((currentStream) => {
        if (currentStream?.trim()) {
          const abortedMsg: ChatMessage = {
            role: "assistant",
            content: currentStream,
            timestamp: Date.now(),
          };
          setMessages((prev) => [...prev, abortedMsg]);
        }
        return null;
      });
    } else if (payload.state === "error") {
      setError(payload.errorMessage ?? "Chat error");
      setChatStream(null);
    }
  });

  const handleNewSession = useCallback(async () => {
    if (state !== "connected") {
      alert("Not connected to gateway");
      return;
    }

    try {
      const res = await request<{ key: string }>("sessions.reset", {
        key: `agent:main:${new Date().getTime()}`,
      });
      if (res.key) {
        // Clear all chat state BEFORE switching session
        // to prevent loadChatHistory from overwriting with old data
        setMessages([]);
        setChatStream(null);
        setError(null);
        setSelectedSessionKey(res.key);
        void loadSessions();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create session");
      alert(err instanceof Error ? err.message : "Failed to create session");
    }
  }, [state, request, loadSessions]);

  const handleDeleteSession = useCallback(
    async (key: string, e: React.MouseEvent) => {
      e.stopPropagation();
      if (!window.confirm("Are you sure you want to delete this session?")) {
        return;
      }

      if (state !== "connected") {
        alert("Not connected to gateway");
        return;
      }

      try {
        const res = await request<{ deleted: boolean }>("sessions.delete", {
          key,
        });
        if (res.deleted) {
          if (selectedSessionKey === key) {
            setSelectedSessionKey(null);
            setMessages([]);
            setChatStream(null);
            setError(null);
          }
          void loadSessions();
        }
      } catch (err) {
        alert(err instanceof Error ? err.message : "Failed to delete session");
      }
    },
    [state, request, selectedSessionKey, loadSessions],
  );

  // ============================================
  // Autocomplete Handlers
  // ============================================

  const handleDraftChange = useCallback((value: string) => {
    setDraft(value);

    // Show autocomplete when typing a command
    const trimmed = value.trim();
    if (trimmed.startsWith("/")) {
      const parts = trimmed.split(/\s+/);
      const commandPart = parts[0].slice(1); // Remove leading /
      if (parts.length === 1 && commandPart) {
        const completions = getCommandCompletions(commandPart);
        if (completions.length > 0) {
          setShowAutocomplete(true);
          setCommandPrefix(commandPart);
          setAutocompleteIndex(0);
        } else {
          setShowAutocomplete(false);
        }
      } else {
        setShowAutocomplete(false);
      }
    } else {
      setShowAutocomplete(false);
    }
  }, []);

  const selectAutocomplete = useCallback(
    (index: number) => {
      const completions = getCommandCompletions(commandPrefix);
      if (completions.length === 0 || index >= completions.length) {
        return;
      }
      const selected = completions[index];
      const trimmed = draft.trim();
      const parts = trimmed.split(/\s+/);
      if (parts.length === 1) {
        // Replace the command only
        setDraft(`/${selected.name} `);
      }
      setShowAutocomplete(false);
      textareaRef.current?.focus();
    },
    [commandPrefix, draft],
  );

  const handleAutocompleteKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!showAutocomplete) {
        return;
      }

      const completions = getCommandCompletions(commandPrefix);
      if (completions.length === 0) {
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAutocompleteIndex((prev) => (prev + 1) % completions.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setAutocompleteIndex((prev) => (prev - 1 + completions.length) % completions.length);
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        selectAutocomplete(autocompleteIndex);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setShowAutocomplete(false);
      } else if (e.key === "Tab") {
        e.preventDefault();
        selectAutocomplete(autocompleteIndex);
      }
    },
    [showAutocomplete, commandPrefix, autocompleteIndex, selectAutocomplete],
  );

  useEffect(() => {
    if (state === "connected") {
      void loadSessions();
      void loadModels();
    }
  }, [state, loadSessions, loadModels]);

  useEffect(() => {
    if (selectedSessionKey) {
      void loadChatHistory();
    }
  }, [selectedSessionKey, loadChatHistory]);

  // Update current model when sessions or selected session changes
  useEffect(() => {
    if (selectedSessionKey && sessions.length > 0) {
      const session = sessions.find((s) => s.key === selectedSessionKey);
      if (session) {
        // Combine provider and model ID properly
        const modelStr =
          session.modelProvider && session.model
            ? `${session.modelProvider}/${session.model}`
            : session.model || session.modelProvider || null;
        setCurrentModel(modelStr);
      }
    }
  }, [selectedSessionKey, sessions]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // First check autocomplete shortcuts
    handleAutocompleteKeyDown(e);

    // Then handle send
    if (e.key === "Enter" && !e.shiftKey && !showAutocomplete) {
      e.preventDefault();
      void sendMessage();
    }
  };

  const isDisabled = state !== "connected";

  return (
    <div style={{ animation: "rise 0.3s ease-out" }}>
      <div style={{ marginBottom: 24 }}>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "-0.025em",
            color: "var(--text-strong)",
            margin: 0,
          }}
        >
          Chat
        </h1>
        <p style={{ color: "var(--muted)", marginTop: 6, marginBottom: 0 }}>
          Send messages and interact with your AI agents.
        </p>
      </div>

      <div
        style={{
          ...styles.layout,
          gridTemplateColumns: isSidebarVisible ? "240px 1fr" : "1fr",
        }}
      >
        {/* Sessions Sidebar */}
        {isSidebarVisible && (
          <div style={styles.sidebar}>
            <div style={styles.cardTitle}>Sessions</div>
            <button
              style={{ ...styles.btn, ...styles.btnPrimary }}
              disabled={isDisabled}
              onClick={handleNewSession}
            >
              New Session
            </button>

            <div style={styles.sessionList}>
              {sessions.length === 0 ? (
                <div style={styles.muted}>No sessions yet.</div>
              ) : (
                sessions.map((session) => {
                  const isActive = selectedSessionKey === session.key;
                  return (
                    <div
                      key={session.key}
                      style={{
                        ...styles.sessionRow,
                        ...(isActive ? styles.sessionRowActive : {}),
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                      onClick={() => setSelectedSessionKey(session.key)}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={styles.sessionTitle}>
                          {session.label || session.displayName || session.key}
                        </div>
                        <div style={styles.sessionSub}>
                          {session.updatedAt
                            ? formatRelativeTimestamp(session.updatedAt)
                            : "No activity"}
                        </div>
                      </div>
                      <button
                        title="Delete Session"
                        onClick={(e) => handleDeleteSession(session.key, e)}
                        style={{
                          background: "transparent",
                          borderWidth: 0,
                          color: "var(--muted)",
                          cursor: "pointer",
                          padding: "4px",
                          fontSize: "14px",
                          lineHeight: 1,
                        }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* Chat Area */}
        <div style={styles.card}>
          {/* Chat Header */}
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: "var(--bg-hover)",
              borderTopLeftRadius: "var(--radius-lg)",
              borderTopRightRadius: "var(--radius-lg)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button
                onClick={() => setIsSidebarVisible(!isSidebarVisible)}
                style={{
                  ...styles.btn,
                  width: "auto",
                  padding: "4px 8px",
                  background: "var(--card)",
                }}
                title={isSidebarVisible ? "Hide Sidebar" : "Show Sidebar"}
              >
                {isSidebarVisible ? "◧ Hide" : "◨ Show Sidebar"}
              </button>
              <h2
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  margin: 0,
                  color: "var(--text-strong)",
                }}
              >
                {selectedSessionKey
                  ? sessions.find((s) => s.key === selectedSessionKey)?.label ||
                    sessions.find((s) => s.key === selectedSessionKey)?.displayName ||
                    selectedSessionKey
                  : "Select a Session"}
              </h2>
            </div>
            {selectedSessionKey && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                {/* Model Selector */}
                <select
                  style={{
                    ...styles.modelSelect,
                    opacity: modelsLoading ? 0.6 : 1,
                  }}
                  value={currentModel || ""}
                  onChange={(e) => changeModel(e.target.value)}
                  disabled={modelsLoading || state !== "connected"}
                  title={modelsLoading ? "Loading models..." : "Select AI model"}
                >
                  <option value="" disabled>
                    {modelsLoading ? "Loading..." : "none"}
                  </option>
                  {models.map((m) => (
                    <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                      {m.name} {m.contextWindow ? `(${Math.round(m.contextWindow / 1024)}k)` : ""}
                      {m.reasoning ? " · Reasoning" : ""}
                    </option>
                  ))}
                </select>

                {/* Clear Chat Button */}
                <button
                  onClick={handleClearChat}
                  style={{
                    ...styles.btn,
                    width: "auto",
                    padding: "4px 10px",
                    background: "var(--card)",
                    color: "var(--danger)",
                    borderColor: "var(--danger)",
                  }}
                  title="Clear chat history (keep session)"
                >
                  🗑️ Clear Chat
                </button>

                {/* Active Session Indicator */}
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--ok)",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontWeight: 500,
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      background: "var(--ok)",
                      borderRadius: "50%",
                    }}
                  />
                  Active
                </div>
              </div>
            )}
          </div>

          {error && <div style={{ ...styles.callout, ...styles.calloutDanger }}>{error}</div>}

          {!selectedSessionKey ? (
            <div style={styles.emptyState}>
              Select a session or create a new one to start chatting.
            </div>
          ) : loading ? (
            <div style={styles.emptyState}>Loading...</div>
          ) : (
            <>
              <div style={styles.messagesArea}>
                {messages.length === 0 && !chatStream ? (
                  <div style={styles.emptyState}>No messages yet. Start the conversation!</div>
                ) : (
                  messages.map((msg, idx) => <Message key={idx} message={msg} />)
                )}
                {/* Streaming response — shown while AI is typing */}
                {chatStream !== null && (
                  <div
                    style={{
                      ...styles.messageRow,
                      ...styles.messageRowAssistant,
                    }}
                  >
                    <div
                      style={{
                        ...styles.bubble,
                        ...styles.bubbleAssistant,
                        opacity: 0.85,
                      }}
                    >
                      {chatStream === "" ? (
                        <span style={{ color: "var(--muted)", fontStyle: "italic" }}>
                          ●●● typing…
                        </span>
                      ) : (
                        chatStream
                      )}
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              <div style={{ ...styles.compose, position: "relative" as const }}>
                {showAutocomplete && (
                  <div style={styles.autocomplete}>
                    {getCommandCompletions(commandPrefix).map((cmd, idx) => (
                      <button
                        key={cmd.name}
                        style={{
                          ...styles.autocompleteItem,
                          ...(idx === autocompleteIndex ? styles.autocompleteItemHover : {}),
                        }}
                        onClick={() => selectAutocomplete(idx)}
                        onMouseEnter={() => setAutocompleteIndex(idx)}
                      >
                        <span>/{cmd.name}</span>
                        <span style={styles.autocompleteDescription}>{cmd.description}</span>
                      </button>
                    ))}
                  </div>
                )}
                <textarea
                  ref={textareaRef}
                  style={styles.input}
                  value={draft}
                  onChange={(e) => handleDraftChange(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    isDisabled ? "Connect to gateway to chat..." : "Type a message (Enter to send)"
                  }
                  disabled={isDisabled || sending}
                  rows={1}
                />
                <button
                  style={{ ...styles.btn, ...styles.btnPrimary, width: "auto" }}
                  disabled={isDisabled || sending || !draft.trim()}
                  onClick={sendMessage}
                >
                  {sending ? "Sending..." : "Send"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Clear Chat Confirmation Modal */}
      {showClearConfirm && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={() => setShowClearConfirm(false)}
        >
          <div
            style={{
              background: "var(--card)",
              borderRadius: "var(--radius-lg)",
              padding: 24,
              maxWidth: 400,
              width: "90%",
              borderWidth: 1,
              borderStyle: "solid",
              borderColor: "var(--border)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3
              style={{
                margin: "0 0 12px 0",
                fontSize: 18,
                fontWeight: 600,
                color: "var(--text-strong)",
              }}
            >
              Clear Chat History?
            </h3>
            <p
              style={{
                margin: "0 0 20px 0",
                fontSize: 14,
                color: "var(--muted)",
                lineHeight: 1.5,
              }}
            >
              This will delete all messages in this conversation. The session will be kept, but the
              chat history cannot be recovered.
            </p>
            <div
              style={{
                display: "flex",
                gap: 12,
                justifyContent: "flex-end",
              }}
            >
              <button
                onClick={() => setShowClearConfirm(false)}
                style={{
                  ...styles.btn,
                  width: "auto",
                  padding: "8px 16px",
                  background: "var(--secondary)",
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmClearChat}
                style={{
                  ...styles.btn,
                  width: "auto",
                  padding: "8px 16px",
                  background: "var(--danger)",
                  borderColor: "var(--danger)",
                  color: "#fff",
                }}
              >
                Clear Chat
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
