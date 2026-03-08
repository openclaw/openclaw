import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

// ─── Types ───

type ToastVariant = "success" | "error" | "info" | "warning";

type Toast = {
  id: string;
  message: string;
  variant: ToastVariant;
  /** Timestamp when the toast was created (for auto-dismiss) */
  createdAt: number;
};

type ToastContextType = {
  toast: (message: string, variant?: ToastVariant) => void;
};

// ─── Context ───

const ToastContext = createContext<ToastContextType | null>(null);

export function useToast(): ToastContextType {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}

// ─── Auto-dismiss duration ───

const DISMISS_MS = 4000;
const MAX_VISIBLE = 3;

let nextId = 0;

// ─── Provider ───

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, variant: ToastVariant = "success") => {
    const id = `toast-${++nextId}`;
    const entry: Toast = { id, message, variant, createdAt: Date.now() };

    setToasts((prev) => {
      // Remove oldest if we hit the cap
      const next = [...prev, entry];
      if (next.length > MAX_VISIBLE) {
        const removed = next.shift();
        if (removed) {
          const timer = timersRef.current.get(removed.id);
          if (timer) {
            clearTimeout(timer);
            timersRef.current.delete(removed.id);
          }
        }
      }
      return next;
    });

    // Auto-dismiss
    const timer = setTimeout(() => {
      timersRef.current.delete(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, DISMISS_MS);
    timersRef.current.set(id, timer);
  }, []);

  // Clean up all timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer);
      }
      timersRef.current.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* Toast container */}
      <div
        className="fixed bottom-4 right-4 z-[100] flex flex-col-reverse gap-2 pointer-events-none"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ─── Individual Toast ───

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const [visible, setVisible] = useState(false);

  // Trigger enter animation on mount
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const Icon =
    toast.variant === "success"
      ? CheckCircle2
      : toast.variant === "info"
        ? Info
        : toast.variant === "warning"
          ? AlertTriangle
          : AlertTriangle;

  const variantStyles: Record<ToastVariant, string> = {
    success: "border-emerald-500/30 bg-emerald-950/80 text-emerald-200",
    error: "border-destructive/30 bg-destructive/10 text-destructive",
    info: "border-blue-500/30 bg-blue-950/80 text-blue-200",
    warning: "border-amber-500/30 bg-amber-950/80 text-amber-200",
  };

  return (
    <div
      className={cn(
        "pointer-events-auto flex items-center gap-3 rounded-xl border px-4 py-3 shadow-lg backdrop-blur-md transition-all duration-300 ease-out min-w-[280px] max-w-[400px]",
        visible ? "translate-x-0 opacity-100" : "translate-x-8 opacity-0",
        variantStyles[toast.variant],
      )}
      role="status"
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1 text-sm font-medium">{toast.message}</span>
      <button
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 rounded-md p-0.5 opacity-60 hover:opacity-100 transition-opacity"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
