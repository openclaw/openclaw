import { motion, AnimatePresence } from "framer-motion";
import { Radio, X, Zap, Send } from "lucide-react";
import { useState } from "react";
import { useAgentStore } from "@/store/agentStore";

export function PingModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const agents = useAgentStore((s) => s.agents);
  const updateAgentStatus = useAgentStore((s) => s.updateAgentStatus);
  const [message, setMessage] = useState("");
  const [selectedAgents, setSelectedAgents] = useState<string[]>(agents.map((a) => a.id));
  const [sent, setSent] = useState(false);

  const toggleAgent = (id: string) => {
    setSelectedAgents((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]));
  };

  const sendPing = () => {
    selectedAgents.forEach((id) => updateAgentStatus(id, "WORKING"));
    setSent(true);
    setTimeout(() => {
      setSent(false);
      onClose();
      setMessage("");
    }, 1500);
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
        className="fixed inset-0 z-[100] bg-void/80 backdrop-blur-xl flex items-center justify-center"
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="glass-panel w-full max-w-md p-6"
          onClick={(e) => e.stopPropagation()}
        >
          {sent ? (
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="text-center py-8"
            >
              <motion.div
                animate={{ scale: [1, 1.5, 1], opacity: [1, 0.5, 1] }}
                transition={{ duration: 0.6 }}
                className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center mx-auto mb-4"
              >
                <Zap className="w-8 h-8 text-primary" />
              </motion.div>
              <p className="text-foreground font-medium">Ping Sent!</p>
              <p className="text-text-2 text-sm mt-1">{selectedAgents.length} agents activated</p>
            </motion.div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Radio className="w-5 h-5 text-primary" />
                  <h3 className="text-lg font-medium text-foreground">Broadcast Ping</h3>
                </div>
                <button onClick={onClose}>
                  <X className="w-4 h-4 text-text-2" />
                </button>
              </div>

              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Type your broadcast message..."
                className="w-full bg-secondary/50 rounded-lg p-3 text-sm text-foreground placeholder:text-text-3 resize-none border border-border focus:border-primary/40 focus:outline-none mb-4"
                rows={3}
              />

              <div className="mb-4">
                <p className="text-[10px] font-mono text-text-2 mb-2">SELECT AGENTS</p>
                <div className="flex gap-2 flex-wrap">
                  {agents.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => toggleAgent(a.id)}
                      className={`text-[11px] font-mono px-3 py-1.5 rounded-full border transition-all ${selectedAgents.includes(a.id) ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-text-2"}`}
                    >
                      {a.name}
                    </button>
                  ))}
                </div>
              </div>

              <button
                onClick={sendPing}
                disabled={selectedAgents.length === 0}
                className="w-full glass-pill py-2.5 text-primary text-sm font-medium hover:glow-accent transition-all flex items-center justify-center gap-2 disabled:opacity-30"
              >
                <Send className="w-4 h-4" /> Send Ping
              </button>
            </>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
