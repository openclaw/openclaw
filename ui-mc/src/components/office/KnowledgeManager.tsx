import { motion, AnimatePresence } from "framer-motion";
import { X, Upload, Plus, FileText, Database, Loader2, BookOpen } from "lucide-react";
import { useState, useRef } from "react";
import { toast } from "sonner";
import { avatarMap } from "@/lib/avatars";
import { ingestKnowledge } from "@/lib/rag";
import { useAgentStore } from "@/store/agentStore";

interface KnowledgeManagerProps {
  open: boolean;
  onClose: () => void;
}

export function KnowledgeManager({ open, onClose }: KnowledgeManagerProps) {
  const agents = useAgentStore((s) => s.agents);
  const [tab, setTab] = useState<"upload" | "custom">("upload");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Custom entry form
  const [content, setContent] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("");
  const [source, setSource] = useState<"custom" | "document">("custom");

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }

    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      toast.error("File too large. Max 5MB.");
      return;
    }

    setUploading(true);
    try {
      // Read file as text and ingest into local knowledge base
      const text = await file.text();
      const result = await ingestKnowledge([
        {
          content: text,
          source: "document",
          source_id: `file-${Date.now()}-${file.name}`,
          agent_id: selectedAgent || undefined,
        },
      ]);
      if (!result.success) {
        throw new Error(result.error);
      }
      toast.success(`"${file.name}" noted locally`);
    } catch (err) {
      console.error("Upload error:", err);
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) {
        fileRef.current.value = "";
      }
    }
  };

  const handleCustomEntry = async () => {
    if (!content.trim()) {
      return;
    }
    setSaving(true);

    const result = await ingestKnowledge([
      {
        content: content.trim(),
        source,
        source_id: `custom-${Date.now()}`,
        agent_id: selectedAgent || undefined,
      },
    ]);

    setSaving(false);
    if (result.success) {
      toast.success("Knowledge entry added");
      setContent("");
    } else {
      toast.error(result.error || "Failed to add entry");
    }
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
          initial={{ y: 40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 40, opacity: 0 }}
          transition={{ type: "spring", stiffness: 400, damping: 35 }}
          className="absolute inset-x-4 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 top-24 sm:w-full sm:max-w-lg glass-panel rounded-2xl overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-primary" />
              <span className="text-xs font-mono font-bold text-foreground tracking-wider">
                KNOWLEDGE BASE
              </span>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded-lg hover:bg-secondary transition-colors"
            >
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-border">
            <button
              onClick={() => setTab("upload")}
              className={`flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 text-[11px] font-mono transition-colors ${
                tab === "upload"
                  ? "text-primary border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Upload className="w-3.5 h-3.5" /> Upload Document
            </button>
            <button
              onClick={() => setTab("custom")}
              className={`flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 text-[11px] font-mono transition-colors ${
                tab === "custom"
                  ? "text-primary border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Plus className="w-3.5 h-3.5" /> Custom Entry
            </button>
          </div>

          <div className="p-4 space-y-4">
            {/* Agent selector */}
            <div>
              <label className="text-[10px] font-mono text-muted-foreground mb-1.5 block">
                ASSIGN TO AGENT (optional)
              </label>
              <div className="flex gap-1.5 flex-wrap">
                <button
                  onClick={() => setSelectedAgent("")}
                  className={`px-2 py-1 rounded-lg text-[10px] font-mono transition-colors ${
                    !selectedAgent
                      ? "bg-primary/10 text-primary border border-primary/30"
                      : "text-muted-foreground hover:text-foreground bg-secondary border border-transparent"
                  }`}
                >
                  None
                </button>
                {agents.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => setSelectedAgent(a.id)}
                    className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-mono transition-colors ${
                      selectedAgent === a.id
                        ? "bg-primary/10 text-primary border border-primary/30"
                        : "text-muted-foreground hover:text-foreground bg-secondary border border-transparent"
                    }`}
                  >
                    <img
                      src={avatarMap[a.id]}
                      alt={a.name}
                      className="w-3.5 h-3.5 rounded-full object-cover"
                    />
                    {a.name}
                  </button>
                ))}
              </div>
            </div>

            {tab === "upload" ? (
              <div className="space-y-3">
                <p className="text-[11px] text-muted-foreground">
                  Upload a text file (.txt, .md, .csv, .json) to index into the knowledge base.
                </p>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".txt,.md,.csv,.json,.log,.xml"
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="w-full flex items-center justify-center gap-2 py-8 rounded-xl border-2 border-dashed border-border hover:border-primary/40 transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  {uploading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      <span className="text-xs font-mono">Processing...</span>
                    </>
                  ) : (
                    <>
                      <FileText className="w-5 h-5" />
                      <span className="text-xs font-mono">Click to upload a document</span>
                    </>
                  )}
                </motion.button>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="text-[10px] font-mono text-muted-foreground mb-1.5 block">
                    SOURCE TYPE
                  </label>
                  <div className="flex gap-1.5">
                    {(["custom", "document"] as const).map((s) => (
                      <button
                        key={s}
                        onClick={() => setSource(s)}
                        className={`px-3 py-1 rounded-lg text-[10px] font-mono transition-colors ${
                          source === s
                            ? "bg-primary/10 text-primary border border-primary/30"
                            : "text-muted-foreground bg-secondary border border-transparent"
                        }`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-mono text-muted-foreground mb-1.5 block">
                    CONTENT
                  </label>
                  <textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="Enter knowledge content... e.g. 'Our Q2 revenue target is $500K with 30% from enterprise deals.'"
                    rows={4}
                    className="w-full bg-secondary/50 rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground border border-border focus:border-primary/40 focus:outline-none resize-none"
                  />
                </div>
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  onClick={handleCustomEntry}
                  disabled={!content.trim() || saving}
                  className="w-full py-2.5 rounded-xl bg-primary/20 text-primary text-xs font-mono hover:bg-primary/30 transition-colors disabled:opacity-30 flex items-center justify-center gap-2"
                >
                  {saving ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Database className="w-3.5 h-3.5" />
                  )}
                  {saving ? "Saving..." : "Add to Knowledge Base"}
                </motion.button>
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
