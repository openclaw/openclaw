import { motion, AnimatePresence } from "framer-motion";
import { X, Send } from "lucide-react";
import { useState } from "react";
import { avatarMap } from "@/lib/avatars";
import { useAgentStore } from "@/store/agentStore";
import { useUIStore } from "@/store/uiStore";

interface ChatMessage {
  id: string;
  agentId: string;
  content: string;
  from: "user" | "agent";
  timestamp: Date;
}

export function StartChatDrawer() {
  const { chatOpen, setChatOpen } = useUIStore();
  const agents = useAgentStore((s) => s.agents);
  const [selectedAgent, setSelectedAgent] = useState("aria");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const agent = agents.find((a) => a.id === selectedAgent);

  const sendMessage = () => {
    if (!input.trim()) {
      return;
    }
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      agentId: selectedAgent,
      content: input,
      from: "user",
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");

    setTimeout(
      () => {
        const responses = [
          `I'll look into that right away. Let me process your request.`,
          `Understood. I'm on it — give me a moment to analyze.`,
          `Great question. Let me pull up the relevant data for you.`,
          `Working on this now. I'll have an update shortly.`,
        ];
        const agentMsg: ChatMessage = {
          id: crypto.randomUUID(),
          agentId: selectedAgent,
          content: responses[Math.floor(Math.random() * responses.length)],
          from: "agent",
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, agentMsg]);
      },
      1000 + Math.random() * 2000,
    );
  };

  if (!chatOpen) {
    return null;
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        className="fixed bottom-16 left-16 right-0 h-[400px] z-50 glass-panel rounded-b-none border-b-0 flex flex-col"
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <img src={avatarMap[selectedAgent]} alt={agent.name} className="w-8 h-8 object-contain" />
          <div className="flex-1">
            <div className="text-sm font-bold" style={{ color: agent.color }}>
              {agent.name}
            </div>
            <div className="text-[10px] text-text-2">{agent.role}</div>
          </div>
          <div className="flex -space-x-1">
            {agents.map((a) => (
              <button
                key={a.id}
                onClick={() => setSelectedAgent(a.id)}
                className={`w-6 h-6 rounded-full border-2 transition-all ${selectedAgent === a.id ? "border-primary scale-110 z-10" : "border-void opacity-50 hover:opacity-100"}`}
                style={{ backgroundColor: `${a.color}30` }}
                title={a.name}
              >
                <span className="text-[8px] font-bold" style={{ color: a.color }}>
                  {a.shortCode}
                </span>
              </button>
            ))}
          </div>
          <button onClick={() => setChatOpen(false)} className="text-text-2 hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-3">
          {messages.length === 0 && (
            <div className="text-center text-text-3 text-sm font-mono py-8">
              Start a conversation with {agent.name}
            </div>
          )}
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`flex ${msg.from === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[70%] rounded-xl px-3 py-2 text-sm ${msg.from === "user" ? "bg-primary/20 text-foreground" : "bg-secondary text-foreground"}`}
              >
                {msg.content}
              </div>
            </motion.div>
          ))}
        </div>

        <div className="px-4 py-3 border-t border-border flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
            placeholder={`Message ${agent.name}...`}
            className="flex-1 bg-secondary/50 rounded-lg px-4 py-2 text-sm text-foreground placeholder:text-text-3 border border-border focus:border-primary/40 focus:outline-none"
          />
          <button
            onClick={sendMessage}
            className="w-9 h-9 rounded-lg bg-primary/20 flex items-center justify-center text-primary hover:bg-primary/30 transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
