import { formatDistanceToNow } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import {
  Check,
  X,
  FileText,
  MessageSquare,
  DollarSign,
  ShieldCheck,
  ClipboardList,
} from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { HeroSection } from "@/components/ui/HeroSection";
import { useApprovalStore } from "@/store/approvalStore";

const typeIcons: Record<string, typeof FileText> = {
  content: MessageSquare,
  document: FileText,
  task: ClipboardList,
  expense: DollarSign,
  access: ShieldCheck,
};

export default function ApprovalsPage() {
  const { approvals, approve, reject } = useApprovalStore();
  const pending = approvals.filter((a) => a.status === "pending");
  const resolved = approvals.filter((a) => a.status !== "pending");

  return (
    <div className="space-y-6">
      <HeroSection
        title="Pending Approvals"
        subtitle={`${pending.length} items awaiting sign-off`}
      />

      {/* Pending Queue */}
      <div className="space-y-3">
        <AnimatePresence mode="popLayout">
          {pending.map((item) => {
            const Icon = typeIcons[item.type] || FileText;
            return (
              <motion.div
                key={item.id}
                layout
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: 200, transition: { duration: 0.3 } }}
              >
                <GlassCard className="p-4" hover={false}>
                  <div className="flex items-start gap-4">
                    <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center shrink-0">
                      <Icon className="w-5 h-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="text-sm font-medium text-foreground">{item.title}</h4>
                      <p className="text-[11px] text-text-2 mt-0.5">{item.preview}</p>
                      <div className="flex items-center gap-3 mt-2 text-[10px] font-mono text-text-3">
                        <span>by {item.submittedBy.toUpperCase()}</span>
                        <span>
                          {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <motion.button
                        whileTap={{ scale: 0.9 }}
                        onClick={() => approve(item.id)}
                        className="w-9 h-9 rounded-lg bg-accent-green/20 flex items-center justify-center text-accent-green hover:bg-accent-green/30 transition-colors"
                      >
                        <Check className="w-4 h-4" />
                      </motion.button>
                      <motion.button
                        whileTap={{ scale: 0.9 }}
                        onClick={() => reject(item.id)}
                        className="w-9 h-9 rounded-lg bg-accent-red/20 flex items-center justify-center text-accent-red hover:bg-accent-red/30 transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </motion.button>
                    </div>
                  </div>
                </GlassCard>
              </motion.div>
            );
          })}
        </AnimatePresence>
        {pending.length === 0 && (
          <GlassCard className="p-8 text-center" hover={false}>
            <div className="text-2xl mb-2 opacity-30">✓</div>
            <p className="text-sm text-text-2">All caught up! No pending approvals.</p>
          </GlassCard>
        )}
      </div>

      {/* Recently Resolved */}
      {resolved.length > 0 && (
        <>
          <h3 className="text-sm font-medium text-text-2 mt-6">Recently Resolved</h3>
          <div className="space-y-2">
            {resolved.map((item) => (
              <div key={item.id} className="flex items-center gap-3 p-3 rounded-lg bg-secondary/30">
                <span
                  className={`w-2 h-2 rounded-full ${item.status === "approved" ? "bg-accent-green" : "bg-accent-red"}`}
                />
                <span className="text-sm text-foreground flex-1">{item.title}</span>
                <span className="text-[10px] font-mono text-text-3 capitalize">{item.status}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
