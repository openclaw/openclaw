import { motion, AnimatePresence } from "framer-motion";
import { X, Keyboard } from "lucide-react";
import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useUIStore } from "@/store/uiStore";

interface Shortcut {
  keys: string[];
  label: string;
  category: string;
}

const SHORTCUTS: Shortcut[] = [
  // Navigation
  { keys: ["⌘", "K"], label: "Open command palette", category: "Navigation" },
  { keys: ["⌘", "?"], label: "Show keyboard shortcuts", category: "Navigation" },
  { keys: ["G", "O"], label: "Go to Office", category: "Navigation" },
  { keys: ["G", "T"], label: "Go to Tasks", category: "Navigation" },
  { keys: ["G", "P"], label: "Go to Projects", category: "Navigation" },
  { keys: ["G", "A"], label: "Go to Analytics", category: "Navigation" },
  { keys: ["G", "C"], label: "Go to Calendar", category: "Navigation" },
  { keys: ["G", "M"], label: "Go to Memory", category: "Navigation" },
  { keys: ["G", "D"], label: "Go to Docs", category: "Navigation" },
  { keys: ["G", "S"], label: "Go to Controls", category: "Navigation" },
  // Actions
  { keys: ["⌘", "L"], label: "Toggle theme", category: "Actions" },
  { keys: ["⌘", "."], label: "Toggle simulation", category: "Actions" },
  { keys: ["⌘", "N"], label: "Start chat", category: "Actions" },
  { keys: ["⌘", "J"], label: "Add new task", category: "Actions" },
  { keys: ["Esc"], label: "Close overlay / modal", category: "Actions" },
];

const NAV_MAP: Record<string, string> = {
  o: "/office",
  t: "/tasks",
  p: "/projects",
  a: "/analytics",
  c: "/calendar",
  m: "/memory",
  d: "/docs",
  s: "/controls",
};

export function useKeyboardShortcuts() {
  const navigate = useNavigate();
  const { setSearchOpen, toggleTheme, setChatOpen, simulationEnabled, setSimulationEnabled } =
    useUIStore();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [gPressed, setGPressed] = useState(false);
  const gTimeout = useCallback(() => {
    setTimeout(() => setGPressed(false), 800);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

      // ⌘? or ⌘/ — shortcuts cheat sheet
      if ((e.metaKey || e.ctrlKey) && (e.key === "?" || (e.shiftKey && e.key === "/"))) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }

      // ⌘L — toggle theme
      if ((e.metaKey || e.ctrlKey) && e.key === "l") {
        e.preventDefault();
        toggleTheme();
        return;
      }

      // ⌘. — toggle simulation
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        setSimulationEnabled(!simulationEnabled);
        return;
      }

      // ⌘N — start chat
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        setChatOpen(true);
        return;
      }

      // Skip text inputs for non-modifier shortcuts
      if (isInput) {
        return;
      }

      // G + key navigation
      if (e.key === "g" && !e.metaKey && !e.ctrlKey) {
        setGPressed(true);
        gTimeout();
        return;
      }

      if (gPressed && NAV_MAP[e.key]) {
        e.preventDefault();
        navigate(NAV_MAP[e.key]);
        setGPressed(false);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    gPressed,
    gTimeout,
    navigate,
    setSearchOpen,
    toggleTheme,
    setChatOpen,
    simulationEnabled,
    setSimulationEnabled,
    setShortcutsOpen,
  ]);

  return { shortcutsOpen, setShortcutsOpen };
}

export function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const categories = [...new Set(SHORTCUTS.map((s) => s.category))];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className="absolute inset-0 bg-background/80 backdrop-blur-sm"
            onClick={onClose}
          />

          <motion.div
            className="relative glass-panel w-full max-w-lg overflow-hidden"
            initial={{ scale: 0.9, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0, y: 20 }}
            transition={{ type: "spring" as const, stiffness: 400, damping: 30 }}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-5 pb-3 border-b border-border">
              <div className="flex items-center gap-2">
                <Keyboard className="w-4 h-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">Keyboard Shortcuts</h2>
              </div>
              <button
                onClick={onClose}
                className="p-1 rounded-lg hover:bg-secondary transition-colors"
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>

            {/* Shortcuts list */}
            <div className="p-5 max-h-[60vh] overflow-y-auto scrollbar-thin space-y-5">
              {categories.map((cat) => (
                <div key={cat}>
                  <h3 className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider mb-2.5">
                    {cat}
                  </h3>
                  <div className="space-y-1">
                    {SHORTCUTS.filter((s) => s.category === cat).map((shortcut, i) => (
                      <motion.div
                        key={shortcut.label}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: i * 0.03 }}
                        className="flex items-center justify-between py-1.5"
                      >
                        <span className="text-sm text-foreground">{shortcut.label}</span>
                        <div className="flex items-center gap-1">
                          {shortcut.keys.map((key, ki) => (
                            <span key={ki}>
                              <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-secondary text-muted-foreground rounded border border-border min-w-[24px] text-center inline-block">
                                {key}
                              </kbd>
                              {ki < shortcut.keys.length - 1 && (
                                <span className="text-muted-foreground text-[10px] mx-0.5">+</span>
                              )}
                            </span>
                          ))}
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-border">
              <p className="text-[10px] font-mono text-muted-foreground text-center">
                Press <kbd className="px-1 py-0.5 bg-secondary rounded border border-border">⌘</kbd>{" "}
                + <kbd className="px-1 py-0.5 bg-secondary rounded border border-border">?</kbd> to
                toggle
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
