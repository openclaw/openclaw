import { ChevronDown, Layers } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface OrgWorkspace {
  id: string;
  name: string;
  brandColor?: string | null;
  status: string;
}

export function WorkspaceSelector({
  workspaces,
  activeWorkspaceId,
  onSelect,
}: {
  workspaces: OrgWorkspace[];
  activeWorkspaceId: string | null;
  onSelect: (workspaceId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as HTMLElement)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const active = workspaces.find((w) => w.id === activeWorkspaceId);

  return (
    <div className="relative" ref={ref}>
      <Button variant="outline" size="sm" onClick={() => setOpen(!open)} className="gap-1.5">
        {active?.brandColor ? (
          <div
            className="size-2.5 rounded-full shrink-0"
            style={{ backgroundColor: active.brandColor }}
          />
        ) : (
          <Layers className="size-3.5" />
        )}
        {active?.name ?? "All Workspaces"}
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </Button>

      {open && (
        <div className="absolute top-full mt-1 left-0 z-50 w-56 bg-card border rounded-lg shadow-lg py-1 max-h-60 overflow-auto">
          <button
            className={cn(
              "w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors",
              !activeWorkspaceId && "font-medium text-foreground",
            )}
            onClick={() => {
              onSelect(null);
              setOpen(false);
            }}
          >
            All Workspaces
          </button>
          {workspaces.filter((w) => w.status !== "archived").length > 0 && (
            <div className="border-t my-1" />
          )}
          {workspaces
            .filter((w) => w.status !== "archived")
            .map((w) => (
              <button
                key={w.id}
                className={cn(
                  "w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex items-center gap-2",
                  activeWorkspaceId === w.id && "font-medium text-foreground",
                )}
                onClick={() => {
                  onSelect(w.id);
                  setOpen(false);
                }}
              >
                <div
                  className="size-2 rounded-full shrink-0"
                  style={{ backgroundColor: w.brandColor ?? "#64748b" }}
                />
                <span className="truncate">{w.name}</span>
              </button>
            ))}
          {workspaces.filter((w) => w.status !== "archived").length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">No workspaces</div>
          )}
        </div>
      )}
    </div>
  );
}
