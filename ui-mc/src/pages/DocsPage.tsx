import { formatDistanceToNow } from "date-fns";
import { motion } from "framer-motion";
import { FileText, File, FileCheck, FileBarChart, FileCode, FileLock, Trash2 } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { HeroSection } from "@/components/ui/HeroSection";
import { useDocStore, DocType } from "@/store/docStore";

const typeIcons: Record<DocType, typeof FileText> = {
  proposal: FileText,
  sla: FileLock,
  brief: File,
  report: FileBarChart,
  template: FileCode,
  contract: FileCheck,
};
const typeColors: Record<DocType, string> = {
  proposal: "#00C8FF",
  sla: "#FF2D55",
  brief: "#BF5AF2",
  report: "#FFD60A",
  template: "#30D158",
  contract: "#FF6B35",
};

export default function DocsPage() {
  const { docs, deleteDoc } = useDocStore();

  return (
    <div className="space-y-6">
      <HeroSection title="Document Vault" subtitle={`${docs.length} documents stored`} />

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {docs.map((doc, i) => {
          const Icon = typeIcons[doc.type];
          const color = typeColors[doc.type];
          return (
            <motion.div
              key={doc.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <GlassCard className="p-4">
                <div className="flex items-start gap-3">
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                    style={{ backgroundColor: `${color}15` }}
                  >
                    <Icon className="w-5 h-5" style={{ color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-sm font-medium text-foreground">{doc.title}</h4>
                    <p className="text-[11px] text-text-2 mt-0.5 line-clamp-2">{doc.description}</p>
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <span
                        className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-full capitalize"
                        style={{ backgroundColor: `${color}20`, color }}
                      >
                        {doc.type}
                      </span>
                      {doc.tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-[9px] font-mono px-1.5 py-0.5 rounded-full bg-secondary text-text-2"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                    <div className="text-[10px] font-mono text-text-3 mt-2">
                      by {doc.agentAuthor.toUpperCase()} · updated{" "}
                      {formatDistanceToNow(new Date(doc.updatedAt), { addSuffix: true })}
                    </div>
                  </div>
                  <button
                    onClick={() => deleteDoc(doc.id)}
                    className="w-7 h-7 rounded-lg bg-secondary/50 flex items-center justify-center text-text-2 hover:text-accent-red transition-colors shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </GlassCard>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
