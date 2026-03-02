"use client";

export interface ZoneLabelProps {
  zones: Array<{
    name: string;
    color: string;
    x: number;
    y: number;
    agentCount: number;
  }>;
}

export function ZoneLabels({ zones }: ZoneLabelProps) {
  return (
    <>
      {zones.map((zone) => (
        <div
          key={zone.name}
          className="absolute pointer-events-none select-none z-[5]"
          style={{
            left: zone.x,
            top: zone.y,
            transform: "translate(-50%, -50%)",
          }}
        >
          <div
            className="rounded-md px-3 py-1.5 backdrop-blur-sm border"
            style={{
              backgroundColor: `${zone.color}20`,
              borderColor: `${zone.color}40`,
            }}
          >
            <div className="text-sm font-semibold tracking-wide" style={{ color: zone.color }}>
              {zone.name}
            </div>
            <div className="text-xs text-muted-foreground tabular-nums">
              {zone.agentCount} {zone.agentCount === 1 ? "agent" : "agents"}
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
