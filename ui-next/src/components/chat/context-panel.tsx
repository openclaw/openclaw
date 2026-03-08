import { X, Wrench, GripVertical } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/custom/prompt/markdown";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export type ContextPanelContent = {
  /** Panel display mode / tab */
  mode: "tool-output";
  /** Title shown in the panel header */
  title: string;
  /** Raw text content to display */
  content: string;
};

export type ContextPanelProps = {
  open: boolean;
  panelContent: ContextPanelContent | null;
  onClose: () => void;
};

const MIN_WIDTH = 300;
const MAX_WIDTH_RATIO = 0.6;
const DEFAULT_WIDTH_RATIO = 0.4;

/** Persisted panel width key in localStorage. */
const PANEL_WIDTH_KEY = "openclaw.control.contextPanelWidth";

function loadPanelWidth(): number {
  try {
    const raw = localStorage.getItem(PANEL_WIDTH_KEY);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= MIN_WIDTH) {
        return n;
      }
    }
  } catch {
    // ignore
  }
  return 0; // 0 = use default ratio
}

function savePanelWidth(width: number) {
  try {
    localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // ignore
  }
}

/**
 * Heuristic: if content has no markdown formatting (headings, lists, links,
 * code fences, bold/italic), treat it as raw terminal output and wrap it in
 * a fenced code block so it renders monospaced with preserved whitespace.
 */
function formatToolContent(content: string): string {
  // Already has markdown structure — pass through
  if (/^#{1,6}\s|^\s*[-*]\s|^\s*\d+\.\s|```|^\|.*\|$/m.test(content)) {
    return content;
  }
  // Looks like raw output (multi-line plain text) — wrap in code fence
  if (content.includes("\n")) {
    return "```\n" + content + "\n```";
  }
  return content;
}

/** Shared content renderer used by both desktop panel and mobile sheet. */
function PanelBody({ panelContent }: { panelContent: ContextPanelContent }) {
  return (
    <div className="flex-1 overflow-y-auto p-4">
      {panelContent.mode === "tool-output" && (
        <div className="text-sm">
          <Markdown>{formatToolContent(panelContent.content)}</Markdown>
        </div>
      )}
    </div>
  );
}

/** Inline resizable context panel (desktop). */
export function ContextPanel({ open, panelContent, onClose }: ContextPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(() => loadPanelWidth());
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  // Compute effective width, clamped to container
  const getEffectiveWidth = useCallback(() => {
    const container = panelRef.current?.parentElement;
    if (!container) {
      return MIN_WIDTH;
    }
    const maxWidth = container.clientWidth * MAX_WIDTH_RATIO;
    const defaultWidth = container.clientWidth * DEFAULT_WIDTH_RATIO;
    const w = width > 0 ? width : defaultWidth;
    return Math.max(MIN_WIDTH, Math.min(w, maxWidth));
  }, [width]);

  // Keyboard shortcut: Escape to close
  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  // Drag handler
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      startX.current = e.clientX;
      startWidth.current = getEffectiveWidth();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMouseMove = (ev: MouseEvent) => {
        if (!isDragging.current) {
          return;
        }
        const container = panelRef.current?.parentElement;
        if (!container) {
          return;
        }
        const maxWidth = container.clientWidth * MAX_WIDTH_RATIO;
        // Dragging left increases panel width (panel is on the right)
        const delta = startX.current - ev.clientX;
        const newWidth = Math.max(MIN_WIDTH, Math.min(startWidth.current + delta, maxWidth));
        setWidth(newWidth);
      };

      const onMouseUp = (ev: MouseEvent) => {
        isDragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        // Persist final width
        const container = panelRef.current?.parentElement;
        if (container) {
          const maxWidth = container.clientWidth * MAX_WIDTH_RATIO;
          const delta = startX.current - ev.clientX;
          const finalWidth = Math.max(MIN_WIDTH, Math.min(startWidth.current + delta, maxWidth));
          setWidth(finalWidth);
          savePanelWidth(finalWidth);
        }
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [getEffectiveWidth],
  );

  if (!open || !panelContent) {
    return null;
  }

  const effectiveWidth = getEffectiveWidth();

  return (
    <div
      ref={panelRef}
      className="h-full shrink-0 flex flex-row border-l border-border bg-background animate-in slide-in-from-right-2 duration-200"
      style={{ width: effectiveWidth }}
    >
      {/* Drag handle */}
      <div
        className="w-1.5 h-full cursor-col-resize flex items-center justify-center group hover:bg-primary/10 active:bg-primary/20 transition-colors shrink-0"
        onMouseDown={onMouseDown}
      >
        <GripVertical className="h-4 w-4 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors" />
      </div>

      {/* Panel content */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
          <Wrench className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium truncate">{panelContent.title}</span>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto h-7 w-7 shrink-0"
            onClick={onClose}
            aria-label="Close panel"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Scrollable content */}
        <PanelBody panelContent={panelContent} />
      </div>
    </div>
  );
}

/**
 * Mobile context panel displayed as a Sheet overlay.
 */
export function ContextPanelSheet({ open, panelContent, onClose }: ContextPanelProps) {
  if (!panelContent) {
    return null;
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <SheetContent side="right" className="w-full sm:max-w-lg md:max-w-xl p-0 flex flex-col">
        <SheetHeader className="border-b border-border px-4 py-3 shrink-0">
          <SheetTitle className="text-sm font-mono flex items-center gap-2">
            <Wrench className="h-4 w-4 text-muted-foreground" />
            {panelContent.title}
          </SheetTitle>
        </SheetHeader>
        <PanelBody panelContent={panelContent} />
      </SheetContent>
    </Sheet>
  );
}
