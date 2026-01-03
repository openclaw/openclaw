import {
  type Component,
  Input,
  isCtrlC,
  isEscape,
  ProcessTerminal,
  Text,
  TUI,
} from "@mariozechner/pi-tui";
import { loadConfig } from "../config/config.js";
import { GatewayChatClient } from "./gateway-chat.js";
import { ChatLayout } from "./layout.js";
import { MessageList } from "./message-list.js";
import { markdownTheme, theme } from "./theme.js";

export type TuiOptions = {
  url?: string;
  token?: string;
  password?: string;
  session?: string;
  deliver?: boolean;
  thinking?: string;
  timeoutMs?: number;
  historyLimit?: number;
};

type ChatEvent = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

class InputWrapper implements Component {
  constructor(
    private input: Input,
    private onAbort: () => void,
    private onExit: () => void,
  ) {}

  handleInput(data: string): void {
    if (isCtrlC(data)) {
      this.onExit();
      return;
    }
    if (isEscape(data)) {
      this.onAbort();
      return;
    }
    this.input.handleInput(data);
  }

  render(width: number): string[] {
    return this.input.render(width);
  }

  invalidate(): void {
    this.input.invalidate();
  }
}

function extractText(message?: unknown): string {
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  const parts = content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") return b.text;
      return "";
    })
    .filter(Boolean);
  return parts.join("\n").trim();
}

function renderHistoryEntry(
  entry: unknown,
): { role: "user" | "assistant"; text: string } | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const role =
    record.role === "user" || record.role === "assistant" ? record.role : null;
  if (!role) return null;
  const text = extractText(record);
  if (!text) return null;
  return { role, text };
}

export async function runTui(opts: TuiOptions) {
  const config = loadConfig();
  const defaultSession =
    (opts.session ?? config.session?.mainKey ?? "main").trim() || "main";
  let currentSession = defaultSession;
  let activeRunId: string | null = null;
  let streamingMessageId: string | null = null;
  let historyLoaded = false;

  const messages = new MessageList(markdownTheme, {
    user: { color: theme.user },
    assistant: { color: theme.assistant },
    system: { color: theme.system, italic: true },
    tool: { color: theme.dim, italic: true },
  });

  const header = new Text("", 1, 0);
  const status = new Text("", 1, 0);
  const input = new Input();

  const tui = new TUI(new ProcessTerminal());
  const inputWrapper = new InputWrapper(
    input,
    async () => {
      if (!activeRunId) return;
      try {
        await client.abortChat({
          sessionKey: currentSession,
          runId: activeRunId,
        });
      } catch (err) {
        messages.addSystem(`Abort failed: ${String(err)}`);
      }
      activeRunId = null;
      streamingMessageId = null;
      setStatus("aborted");
      tui.requestRender();
    },
    () => {
      client.stop();
      tui.stop();
      process.exit(0);
    },
  );

  const layout = new ChatLayout(header, messages, status, inputWrapper);
  tui.addChild(layout);
  tui.setFocus(inputWrapper);

  const client = new GatewayChatClient({
    url: opts.url,
    token: opts.token,
    password: opts.password,
  });

  const updateHeader = () => {
    header.setText(
      theme.header(
        `clawdis tui - ${client.connection.url} - session ${currentSession}`,
      ),
    );
  };

  const setStatus = (text: string) => {
    status.setText(theme.dim(text));
  };

  const loadHistory = async () => {
    try {
      const history = await client.loadHistory({
        sessionKey: currentSession,
        limit: opts.historyLimit ?? 200,
      });
      const historyRecord = history as { messages?: unknown[] } | undefined;
      messages.clearAll();
      messages.addSystem(`session ${currentSession}`);
      for (const entry of historyRecord?.messages ?? []) {
        const parsed = renderHistoryEntry(entry);
        if (!parsed) continue;
        if (parsed.role === "user") messages.addUser(parsed.text);
        if (parsed.role === "assistant") messages.addAssistant(parsed.text);
      }
      historyLoaded = true;
      tui.requestRender();
    } catch (err) {
      messages.addSystem(`history failed: ${String(err)}`);
      tui.requestRender();
    }
  };

  const handleChatEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const evt = payload as ChatEvent;
    if (evt.sessionKey !== currentSession) return;

    if (evt.state === "delta") {
      const text = extractText(evt.message);
      if (!text) return;
      if (!streamingMessageId || activeRunId !== evt.runId) {
        streamingMessageId = messages.addAssistant(text, evt.runId);
        activeRunId = evt.runId;
      } else {
        messages.updateAssistant(streamingMessageId, text);
      }
      setStatus("streaming");
    }

    if (evt.state === "final") {
      const text = extractText(evt.message);
      if (streamingMessageId && activeRunId === evt.runId) {
        messages.updateAssistant(streamingMessageId, text || "(no output)");
      } else if (text) {
        messages.addAssistant(text, evt.runId);
      }
      activeRunId = null;
      streamingMessageId = null;
      setStatus("idle");
    }

    if (evt.state === "aborted") {
      messages.addSystem("run aborted");
      activeRunId = null;
      streamingMessageId = null;
      setStatus("aborted");
    }

    if (evt.state === "error") {
      messages.addSystem(`run error: ${evt.errorMessage ?? "unknown"}`);
      activeRunId = null;
      streamingMessageId = null;
      setStatus("error");
    }

    tui.requestRender();
  };

  const handleCommand = async (raw: string) => {
    const [command, ...rest] = raw.slice(1).trim().split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (command) {
      case "help": {
        messages.addSystem("/help /session <key> /abort /exit");
        break;
      }
      case "session": {
        if (!arg) {
          messages.addSystem("missing session key");
          break;
        }
        currentSession = arg;
        activeRunId = null;
        streamingMessageId = null;
        historyLoaded = false;
        updateHeader();
        await loadHistory();
        break;
      }
      case "abort": {
        if (!activeRunId) {
          messages.addSystem("no active run");
          break;
        }
        await client.abortChat({
          sessionKey: currentSession,
          runId: activeRunId,
        });
        break;
      }
      case "exit": {
        client.stop();
        tui.stop();
        process.exit(0);
        break;
      }
      case "quit": {
        client.stop();
        tui.stop();
        process.exit(0);
        break;
      }
      default:
        messages.addSystem(`unknown command: /${command}`);
        break;
    }
    tui.requestRender();
  };

  const sendMessage = async (text: string) => {
    try {
      messages.addUser(text);
      tui.requestRender();
      setStatus("sending");
      const { runId } = await client.sendChat({
        sessionKey: currentSession,
        message: text,
        thinking: opts.thinking,
        deliver: opts.deliver,
        timeoutMs: opts.timeoutMs,
      });
      activeRunId = runId;
      streamingMessageId = null;
      setStatus("waiting");
    } catch (err) {
      messages.addSystem(`send failed: ${String(err)}`);
      setStatus("error");
    }
    tui.requestRender();
  };

  input.onSubmit = (value) => {
    const text = value.trim();
    input.setValue("");
    if (!text) return;
    if (text.startsWith("/")) {
      void handleCommand(text);
      return;
    }
    void sendMessage(text);
  };

  client.onEvent = (evt) => {
    if (evt.event === "chat") handleChatEvent(evt.payload);
  };

  client.onConnected = () => {
    setStatus("connected");
    updateHeader();
    if (!historyLoaded) {
      void loadHistory().then(() => {
        messages.addSystem("gateway connected");
        tui.requestRender();
      });
    } else {
      messages.addSystem("gateway reconnected");
    }
    tui.requestRender();
  };

  client.onDisconnected = (reason) => {
    messages.addSystem(`gateway disconnected: ${reason || "closed"}`);
    setStatus("disconnected");
    tui.requestRender();
  };

  client.onGap = (info) => {
    messages.addSystem(
      `event gap: expected ${info.expected}, got ${info.received}`,
    );
    tui.requestRender();
  };

  updateHeader();
  setStatus("connecting");
  messages.addSystem("connecting...");
  tui.start();
  client.start();
}
