import { motion, AnimatePresence } from "framer-motion";
import { Terminal, Send, X, Bot, User, RefreshCw, Database } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";
import { avatarMap } from "@/lib/avatars";
import { streamRagChat, syncAllKnowledge } from "@/lib/rag";
import { useActivityStore } from "@/store/activityStore";
import { useAgentStore } from "@/store/agentStore";
import { useMemoryStore } from "@/store/memoryStore";
import { useTaskStore } from "@/store/taskStore";

interface Message {
  id: string;
  role: "user" | "assistant";
  agentId?: string;
  text: string;
  timestamp: Date;
}

export function AgentCommandPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const agents = useAgentStore((s) => s.agents);
  const addEvent = useActivityStore((s) => s.addEvent);
  const memories = useMemoryStore((s) => s.memories);
  const tasks = useTaskStore((s) => s.tasks);
  const activities = useActivityStore((s) => s.events);

  const [selectedAgent, setSelectedAgent] = useState("main");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const agent = agents.find((a) => a.id === selectedAgent);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 200);
    }
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const syncKnowledge = async () => {
    setIsSyncing(true);
    const result = await syncAllKnowledge(memories, tasks, activities);
    setIsSyncing(false);

    if (result.success) {
      toast.success(`Knowledge synced: ${result.total} items indexed`);
    } else {
      toast.error(result.error || "Failed to sync knowledge");
    }
  };

  const sendMessage = async () => {
    if (!input.trim() || isStreaming) {
      return;
    }

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      text: input.trim(),
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMsg]);
    addEvent({
      agentId: selectedAgent,
      agentName: agent.name,
      agentColor: agent.color,
      action: `received command: "${input.trim()}"`,
    });

    const userInput = input.trim();
    setInput("");
    setIsStreaming(true);

    // Build conversation history for context
    const conversationHistory = [...messages, userMsg].map((m) => ({
      role: m.role,
      content: m.text,
    }));

    // Create assistant message placeholder
    const assistantMsgId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      {
        id: assistantMsgId,
        role: "assistant",
        agentId: selectedAgent,
        text: "",
        timestamp: new Date(),
      },
    ]);

    let fullResponse = "";

    await streamRagChat({
      messages: conversationHistory,
      agentId: selectedAgent,
      agentName: agent.name,
      agentRole: agent.role,
      onDelta: (chunk) => {
        fullResponse += chunk;
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsgId ? { ...m, text: fullResponse } : m)),
        );
      },
      onDone: () => {
        setIsStreaming(false);
      },
      onError: (error) => {
        setIsStreaming(false);
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsgId ? { ...m, text: `⚠️ ${error}` } : m)),
        );
        toast.error(error);
      },
    });
  };

  if (!open) {
    return null;
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[90] bg-void/60 backdrop-blur-sm"
        onClick={onClose}
      >
        <motion.div
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ type: "spring", stiffness: 400, damping: 35 }}
          className="absolute right-0 top-14 bottom-16 w-full max-w-md glass-panel rounded-l-2xl overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-primary" />
              <span className="text-xs font-mono font-bold text-foreground tracking-wider">
                AGENT COMMAND
              </span>
              <span className="text-[9px] font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                RAG
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={syncKnowledge}
                disabled={isSyncing}
                className="p-1.5 rounded-lg hover:bg-secondary transition-colors disabled:opacity-50"
                title="Sync knowledge base"
              >
                <Database
                  className={`w-3.5 h-3.5 text-muted-foreground ${isSyncing ? "animate-pulse" : ""}`}
                />
              </button>
              <button
                onClick={onClose}
                className="p-1 rounded-lg hover:bg-secondary transition-colors"
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
          </div>

          {/* Agent selector */}
          <div className="flex gap-1.5 px-3 py-2 border-b border-border overflow-x-auto scrollbar-thin">
            {agents.map((a) => (
              <button
                key={a.id}
                onClick={() => setSelectedAgent(a.id)}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-mono whitespace-nowrap transition-colors ${
                  selectedAgent === a.id
                    ? "bg-primary/10 text-primary border border-primary/30"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary border border-transparent"
                }`}
              >
                <img
                  src={avatarMap[a.id]}
                  alt={a.name}
                  className="w-4 h-4 rounded-full object-cover"
                />
                {a.name}
              </button>
            ))}
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-3">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center opacity-50">
                <Bot className="w-10 h-10 text-muted-foreground mb-3" />
                <p className="text-xs font-mono text-muted-foreground">
                  Send a command to {agent.name}
                </p>
                <p className="text-[10px] text-muted-foreground mt-1">{agent.role}</p>
                <button
                  onClick={syncKnowledge}
                  className="mt-4 text-[10px] font-mono text-primary/70 hover:text-primary flex items-center gap-1"
                >
                  <Database className="w-3 h-3" />
                  Sync knowledge first for context
                </button>
              </div>
            )}
            {messages.map((msg) => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex gap-2 ${msg.role === "user" ? "flex-row-reverse" : ""}`}
              >
                <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 bg-secondary">
                  {msg.role === "user" ? (
                    <User className="w-3 h-3 text-muted-foreground" />
                  ) : (
                    <img
                      src={avatarMap[msg.agentId || selectedAgent]}
                      alt=""
                      className="w-6 h-6 rounded-full object-cover"
                    />
                  )}
                </div>
                <div
                  className={`max-w-[75%] px-3 py-2 rounded-xl text-xs ${
                    msg.role === "user"
                      ? "bg-primary/15 text-foreground rounded-br-sm"
                      : "bg-secondary text-foreground rounded-bl-sm"
                  }`}
                >
                  {msg.text || (
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <RefreshCw className="w-3 h-3 animate-spin" />
                      Thinking...
                    </span>
                  )}
                </div>
              </motion.div>
            ))}
          </div>

          {/* Input */}
          <div className="px-3 py-3 border-t border-border">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
                placeholder={`Command ${agent.name}...`}
                disabled={isStreaming}
                className="flex-1 bg-secondary/50 rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground border border-border focus:border-primary/40 focus:outline-none disabled:opacity-50"
              />
              <motion.button
                whileTap={{ scale: 0.9 }}
                onClick={sendMessage}
                disabled={!input.trim() || isStreaming}
                className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center text-primary hover:bg-primary/30 transition-colors disabled:opacity-30"
              >
                {isStreaming ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </motion.button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
