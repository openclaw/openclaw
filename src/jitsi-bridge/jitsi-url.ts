function encodeFragmentValue(value: string): string {
  return JSON.stringify(value);
}

export function slugifyRoomId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function createRoomId(topic?: string, roomTopicFallback = "meeting-briefing"): string {
  const fallbackTopic = roomTopicFallback.trim() || "meeting-briefing";
  const prefix = slugifyRoomId(topic || fallbackTopic) || fallbackTopic;
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `${prefix}-${stamp}`;
}

export function buildJitsiRoomUrl(params: {
  baseUrl: string;
  roomId: string;
  displayName: string;
}): string {
  const normalizedBase = params.baseUrl.replace(/\/+$/, "");
  const fragments = [
    "config.prejoinPageEnabled=false",
    "config.prejoinConfig.enabled=false",
    "config.startWithAudioMuted=false",
    "config.startWithVideoMuted=true",
    "config.disableDeepLinking=true",
    `userInfo.displayName=${encodeFragmentValue(params.displayName)}`,
  ];
  return `${normalizedBase}/${params.roomId}#${fragments.join("&")}`;
}

export function buildMeetingStartUrl(params: {
  baseUrl: string;
  roomId: string;
  joinToken: string;
}): string {
  const normalizedBase = params.baseUrl.replace(/\/+$/, "");
  const roomId = encodeURIComponent(params.roomId);
  const token = encodeURIComponent(params.joinToken);
  return `${normalizedBase}/meeting/${roomId}/start?token=${token}`;
}
