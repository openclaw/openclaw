import { useState, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useRPCQuery } from "@/hooks";

export function LogsPage() {
  const [filter, setFilter] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data, isLoading } = useRPCQuery<{
    lines: string[];
    cursor: string;
  }>("logs.tail", { limit: 200, maxBytes: 65536 }, { refetchInterval: 2000 });

  const filteredLines =
    data?.lines.filter((line) =>
      filter ? line.toLowerCase().includes(filter.toLowerCase()) : true,
    ) ?? [];

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [data?.lines]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Logs</h1>
        <Input
          placeholder="Filter logs..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-64"
        />
      </div>

      {isLoading ? (
        <div className="space-y-1">
          {Array.from({ length: 20 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : (
        <ScrollArea className="h-[calc(100vh-200px)] border rounded-md p-4">
          <div className="font-mono text-xs space-y-0.5">
            {filteredLines.map((line, i) => (
              <div
                key={i}
                className="hover:bg-accent px-1 rounded whitespace-pre-wrap break-all"
              >
                {line}
              </div>
            ))}
            <div ref={scrollRef} />
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
