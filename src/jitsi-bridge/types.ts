export type JitsiBridgeRoomStatus =
  | "created"
  | "briefed"
  | "joining"
  | "joined"
  | "stopped"
  | "error";

export type JitsiBridgeRoomRecord = {
  id: string;
  topic?: string;
  jitsiUrl: string;
  startUrl?: string;
  joinToken: string;
  displayName: string;
  inviteEmail?: string;
  realtimeModel: string;
  briefing: string;
  status: JitsiBridgeRoomStatus;
  createdAt: string;
  updatedAt: string;
  lastJoinPid?: number;
  lastError?: string;
};

export type CreateRoomInput = {
  id?: string;
  topic?: string;
  inviteEmail?: string;
  realtimeModel: string;
  displayName: string;
};
