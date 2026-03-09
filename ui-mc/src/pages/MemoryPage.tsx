import { formatDistanceToNow } from "date-fns";
import { motion } from "framer-motion";
import { Pin, PinOff, Trash2, Search } from "lucide-react";
import { useState } from "react";
import { GlassCard } from "@/components/ui/GlassCard";
import { HeroSection } from "@/components/ui/HeroSection";
import { useMemoryStore, MemoryCategory } from "@/store/memoryStore";

const catColors: Record<MemoryCategory, string> = {
  business: "#00C8FF",
  personal: "#30D158",
  technical: "#BF5AF2",
  family: "#FF6B35",
  goals: "#FFD60A",
};

export default function MemoryPage() {
  const { memories, togglePin, deleteMemory } = useMemoryStore();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<MemoryCategory | "all">("all");

  const filtered = memories.filter((m) => {
    if (filter !== "all" && m.category !== filter) {
      return false;
    }
    if (
      search &&
      !m.content.toLowerCase().includes(search.toLowerCase()) &&
      !m.tags.some((t) => t.includes(search.toLowerCase()))
    ) {
      return false;
    }
    return true;
  });

  const pinned = filtered.filter((m) => m.pinned);
  const unpinned = filtered.filter((m) => !m.pinned);

  return (
    <div className="space-y-6">
      <HeroSection title="Agent Memory Bank" subtitle={`${memories.length} memories stored`} />

      {/* Search & Filters */}
      <div className="flex gap-3 items-center flex-wrap">
        <div className="flex-1 min-w-[200px] relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-3" />
          <input
            className="w-full bg-secondary/50 rounded-lg pl-10 pr-4 py-2 text-sm text-foreground placeholder:text-text-3 border border-border focus:border-primary/40 focus:outline-none"
            placeholder="Search memories..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-1">
          {(["all", "business", "personal", "technical", "family", "goals"] as const).map((cat) => (
            <button
              key={cat}
              onClick={() => setFilter(cat)}
              className={`text-[10px] font-mono px-3 py-1.5 rounded-full transition-all ${filter === cat ? "bg-primary/20 text-primary" : "bg-secondary text-text-2 hover:text-foreground"}`}
            >
              {cat === "all" ? "All" : cat}
            </button>
          ))}
        </div>
      </div>

      {/* Pinned */}
      {pinned.length > 0 && (
        <>
          <h3 className="text-xs font-mono text-text-2 flex items-center gap-1">
            <Pin className="w-3 h-3" /> PINNED
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {pinned.map((mem, i) => (
              <MemoryCard
                key={mem.id}
                mem={mem}
                index={i}
                onTogglePin={togglePin}
                onDelete={deleteMemory}
              />
            ))}
          </div>
        </>
      )}

      {/* All */}
      <div className="space-y-3">
        {unpinned.map((mem, i) => (
          <MemoryCard
            key={mem.id}
            mem={mem}
            index={i}
            onTogglePin={togglePin}
            onDelete={deleteMemory}
          />
        ))}
      </div>
    </div>
  );
}

function MemoryCard({
  mem,
  index,
  onTogglePin,
  onDelete,
}: {
  mem: any;
  index: number;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03 }}
    >
      <GlassCard className="p-4" hover={false}>
        <div className="flex items-start gap-3">
          <span
            className="w-2 h-2 rounded-full mt-1.5 shrink-0"
            style={{ backgroundColor: catColors[mem.category as MemoryCategory] }}
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-foreground">{mem.content}</p>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span
                className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-full capitalize"
                style={{
                  backgroundColor: `${catColors[mem.category as MemoryCategory]}20`,
                  color: catColors[mem.category as MemoryCategory],
                }}
              >
                {mem.category}
              </span>
              {mem.tags.map((tag: string) => (
                <span
                  key={tag}
                  className="text-[9px] font-mono px-1.5 py-0.5 rounded-full bg-secondary text-text-2"
                >
                  {tag}
                </span>
              ))}
              <span className="text-[9px] font-mono text-text-3 ml-auto">
                {mem.agentId.toUpperCase()} ·{" "}
                {formatDistanceToNow(new Date(mem.createdAt), { addSuffix: true })}
              </span>
            </div>
          </div>
          <div className="flex gap-1 shrink-0">
            <button
              onClick={() => onTogglePin(mem.id)}
              className="w-7 h-7 rounded-lg bg-secondary/50 flex items-center justify-center text-text-2 hover:text-primary transition-colors"
            >
              {mem.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={() => onDelete(mem.id)}
              className="w-7 h-7 rounded-lg bg-secondary/50 flex items-center justify-center text-text-2 hover:text-accent-red transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </GlassCard>
    </motion.div>
  );
}
