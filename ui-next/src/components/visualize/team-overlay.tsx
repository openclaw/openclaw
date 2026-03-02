"use client";

import type { TeamRunEntry } from "@/store/visualize-store";

export interface TeamOverlayProps {
  teams: TeamRunEntry[];
}

/**
 * Floating badge overlay that displays active team run groupings
 * on the canvas. Each badge shows the team name, member count,
 * and leader name using a Matrix-themed style.
 */
export function TeamOverlay({ teams }: TeamOverlayProps) {
  if (teams.length === 0) {
    return null;
  }

  return (
    <div className="absolute top-2 right-2 z-10 flex flex-col gap-1.5 pointer-events-none">
      {teams.map((team) => (
        <div
          key={team.id}
          className="pointer-events-auto select-none rounded-md border px-3 py-1.5 backdrop-blur-sm"
          style={{
            backgroundColor: "rgba(0, 0, 0, 0.7)",
            borderColor: "rgba(0, 255, 65, 0.3)",
          }}
        >
          <div className="text-xs font-semibold tracking-wide" style={{ color: "#00ff41" }}>
            {team.name}
          </div>
          <div className="text-[10px] leading-tight" style={{ color: "#00cc33" }}>
            {team.memberAgentIds.length} {team.memberAgentIds.length === 1 ? "member" : "members"}
            {" \u00b7 "}lead: {team.leader}
          </div>
        </div>
      ))}
    </div>
  );
}
