import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-shimmer rounded-md bg-gradient-to-r from-secondary via-muted to-secondary bg-[length:200%_100%]",
        className,
      )}
      {...props}
    />
  );
}

function CardSkeleton() {
  return (
    <div className="glass-panel p-4 space-y-3">
      <div className="flex items-center gap-3">
        <Skeleton className="w-10 h-10 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-2 w-1/2" />
        </div>
      </div>
      <Skeleton className="h-2 w-full" />
      <Skeleton className="h-2 w-2/3" />
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="glass-panel p-5 space-y-4">
      <Skeleton className="h-3 w-1/3" />
      <div className="flex items-end gap-2 h-[200px] pt-8">
        {[60, 80, 45, 90, 70, 55, 85].map((h, i) => (
          <div key={i} className="flex-1">
            <Skeleton className="w-full rounded-t-md" style={{ height: `${h}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function AgentCardSkeleton() {
  return (
    <div className="glass-panel p-0 overflow-hidden">
      <div className="pt-4 px-4 flex flex-col items-center">
        <Skeleton className="w-28 h-28 rounded-full mb-3" />
        <Skeleton className="h-4 w-20 mb-2" />
        <Skeleton className="h-2 w-24 mb-1" />
        <Skeleton className="h-2 w-32 mb-4" />
      </div>
      <div className="px-4 mb-3">
        <Skeleton className="h-1.5 w-full rounded-full" />
      </div>
      <div className="px-4 py-3 border-t border-border flex items-center justify-between">
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="h-3 w-20" />
      </div>
    </div>
  );
}

function KPISkeleton() {
  return (
    <div className="glass-panel p-4 text-center space-y-2">
      <Skeleton className="h-2 w-2/3 mx-auto" />
      <Skeleton className="h-6 w-1/2 mx-auto" />
    </div>
  );
}

function EventFeedSkeleton() {
  return (
    <div className="glass-panel p-4 space-y-3">
      <div className="flex items-center gap-2 mb-3">
        <Skeleton className="w-1.5 h-1.5 rounded-full" />
        <Skeleton className="h-3 w-20" />
      </div>
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex items-start gap-2">
          <Skeleton className="w-2 h-2 rounded-full mt-1 shrink-0" />
          <div className="flex-1 space-y-1">
            <Skeleton className="h-2.5 w-full" />
          </div>
          <Skeleton className="h-2 w-12 shrink-0" />
        </div>
      ))}
    </div>
  );
}

function SystemHealthSkeleton() {
  return (
    <div className="glass-panel p-4 space-y-4">
      <Skeleton className="h-3 w-24" />
      <div className="grid grid-cols-2 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="text-center space-y-2">
            <Skeleton className="h-7 w-12 mx-auto" />
            <Skeleton className="h-2 w-16 mx-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}

function QuickDispatchSkeleton() {
  return (
    <div className="glass-panel p-4 space-y-3">
      <div className="flex items-center gap-2 mb-3">
        <Skeleton className="w-4 h-4 rounded" />
        <Skeleton className="h-3 w-24" />
      </div>
      <Skeleton className="h-9 w-full rounded-lg" />
      <div className="flex gap-2">
        <Skeleton className="h-7 flex-1 rounded-lg" />
        <Skeleton className="h-7 w-24 rounded-lg" />
        <Skeleton className="h-7 w-8 rounded-lg" />
      </div>
    </div>
  );
}

function CollaborationGraphSkeleton() {
  return (
    <div className="glass-panel p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Skeleton className="w-4 h-4 rounded" />
          <Skeleton className="h-3 w-36" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-7 w-7 rounded-lg" />
          <Skeleton className="h-7 w-7 rounded-lg" />
        </div>
      </div>
      <Skeleton className="h-[300px] w-full rounded-xl" />
    </div>
  );
}

function TaskColumnSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-3">
        <Skeleton className="w-2 h-2 rounded-full" />
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-4 w-6 rounded-full ml-auto" />
      </div>
      {[1, 2, 3].map((i) => (
        <div key={i} className="glass-panel p-3 space-y-2">
          <div className="flex items-start gap-2">
            <Skeleton className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-2 w-full" />
              <Skeleton className="h-1 w-full rounded-full" />
              <div className="flex items-center justify-between">
                <Skeleton className="h-2 w-12" />
                <Skeleton className="h-2 w-16" />
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function TaskBoardSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
      {[1, 2, 3, 4].map((i) => (
        <TaskColumnSkeleton key={i} />
      ))}
    </div>
  );
}

function ProjectCardSkeleton() {
  return (
    <div className="glass-panel p-5 space-y-4">
      <div className="flex items-start gap-4">
        <Skeleton className="w-20 h-20 rounded-full shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-16 rounded-full" />
          </div>
          <Skeleton className="h-2 w-full" />
          <Skeleton className="h-2 w-3/4" />
          <div className="flex gap-1">
            <Skeleton className="h-4 w-10 rounded" />
            <Skeleton className="h-4 w-10 rounded" />
          </div>
        </div>
      </div>
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="w-4 h-4 rounded-full" />
            <Skeleton className="h-2 flex-1" />
            <Skeleton className="h-2 w-12" />
          </div>
        ))}
      </div>
    </div>
  );
}

function CalendarSkeleton() {
  return (
    <div className="glass-panel p-5 space-y-3">
      <div className="flex items-center gap-2 mb-4">
        <Skeleton className="w-4 h-4 rounded" />
        <Skeleton className="h-3 w-28" />
      </div>
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex items-start gap-3 p-3 rounded-lg bg-secondary/30">
          <Skeleton className="h-3 w-12 shrink-0" />
          <Skeleton className="w-1 h-10 rounded-full shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-2 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

function AnalyticsPageSkeleton() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="glass-panel p-6 space-y-2">
        <Skeleton className="h-8 w-1/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <KPISkeleton key={i} />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartSkeleton />
        <ChartSkeleton />
      </div>
    </div>
  );
}

function OfficePageSkeleton() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="glass-panel p-6 space-y-2">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
          <AgentCardSkeleton key={i} />
        ))}
      </div>
      <CollaborationGraphSkeleton />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <EventFeedSkeleton />
        <SystemHealthSkeleton />
        <QuickDispatchSkeleton />
      </div>
    </div>
  );
}

export {
  Skeleton,
  CardSkeleton,
  ChartSkeleton,
  AgentCardSkeleton,
  KPISkeleton,
  EventFeedSkeleton,
  SystemHealthSkeleton,
  QuickDispatchSkeleton,
  CollaborationGraphSkeleton,
  TaskColumnSkeleton,
  TaskBoardSkeleton,
  ProjectCardSkeleton,
  CalendarSkeleton,
  AnalyticsPageSkeleton,
  OfficePageSkeleton,
};
