import { motion } from "framer-motion";
import { Linkedin, Twitter, Youtube, Instagram, PenLine, Send } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { HeroSection } from "@/components/ui/HeroSection";
import { useContentStore, ContentStatus, Platform } from "@/store/contentStore";

const platformIcons: Record<Platform, typeof Linkedin> = {
  linkedin: Linkedin,
  x: Twitter,
  youtube: Youtube,
  instagram: Instagram,
};
const platformColors: Record<Platform, string> = {
  linkedin: "#0A66C2",
  x: "#1DA1F2",
  youtube: "#FF0000",
  instagram: "#E4405F",
};
const COLUMNS: { id: ContentStatus; label: string }[] = [
  { id: "idea", label: "Ideas" },
  { id: "draft", label: "Drafts" },
  { id: "review", label: "Review" },
  { id: "scheduled", label: "Scheduled" },
  { id: "published", label: "Published" },
];

export default function ContentPage() {
  const items = useContentStore((s) => s.items);
  const published = items.filter((i) => i.status === "published").length;
  const scheduled = items.filter((i) => i.status === "scheduled").length;

  return (
    <div className="space-y-6">
      <HeroSection
        title="Content Engine"
        subtitle={`${items.length} in pipeline · ${published} published · ${scheduled} scheduled`}
      />

      {/* Pipeline Board */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        {COLUMNS.map((col) => (
          <div key={col.id}>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-sm font-medium text-foreground">{col.label}</span>
              <span className="text-[10px] font-mono text-text-2 ml-auto">
                {items.filter((i) => i.status === col.id).length}
              </span>
            </div>
            <div className="space-y-3">
              {items
                .filter((i) => i.status === col.id)
                .map((item, idx) => {
                  const Icon = platformIcons[item.platform];
                  return (
                    <motion.div
                      key={item.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.05 }}
                    >
                      <GlassCard className="p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <Icon
                            className="w-4 h-4"
                            style={{ color: platformColors[item.platform] }}
                          />
                          <span className="text-[10px] font-mono text-text-2 capitalize">
                            {item.platform}
                          </span>
                        </div>
                        <h4 className="text-sm font-medium text-foreground mb-1">{item.title}</h4>
                        <p className="text-[11px] text-text-2 line-clamp-2">{item.preview}</p>
                        {item.engagement && (
                          <div className="flex gap-3 mt-2 text-[10px] font-mono text-text-2">
                            <span>❤ {item.engagement.likes}</span>
                            <span>↗ {item.engagement.shares}</span>
                            <span>👁 {item.engagement.views}</span>
                          </div>
                        )}
                      </GlassCard>
                    </motion.div>
                  );
                })}
            </div>
          </div>
        ))}
      </div>

      {/* Quick Create */}
      <GlassCard className="p-5" hover={false}>
        <div className="flex items-center gap-2 mb-3">
          <PenLine className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-medium text-foreground">Quick Create</h3>
        </div>
        <div className="flex gap-3">
          <textarea
            className="flex-1 bg-secondary/50 rounded-lg p-3 text-sm text-foreground placeholder:text-text-3 resize-none border border-border focus:border-primary/40 focus:outline-none"
            rows={2}
            placeholder="Describe your content idea..."
          />
          <button className="glass-pill px-4 py-2 text-primary text-sm font-medium hover:glow-accent transition-all flex items-center gap-2 self-end">
            <Send className="w-4 h-4" />
            Generate
          </button>
        </div>
      </GlassCard>
    </div>
  );
}
