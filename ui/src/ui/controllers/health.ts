import type { GatewayBrowserClient } from "../gateway.ts";

export type HealthChannelEntry = {
  id: string;
  label: string;
  configured: boolean;
  linked: boolean;
};

export type HealthAgentEntry = {
  agentId: string;
  name?: string;
  isDefault: boolean;
  heartbeatAlive: boolean;
  heartbeatAgeMs: number | null;
  sessionCount: number;
};

export type SystemResourceMetrics = {
  cpu: {
    model: string;
    cores: number;
    loadAvg: [number, number, number];
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
    process: {
      rssBytes: number;
      heapUsedBytes: number;
      heapTotalBytes: number;
    };
  };
  disk: {
    path: string;
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
  } | null;
  uptime: {
    systemSeconds: number;
    processSeconds: number;
  };
  platform: {
    os: string;
    arch: string;
    nodeVersion: string;
    hostname: string;
  };
};

export type HealthData = {
  ok: boolean;
  ts: number;
  durationMs: number;
  heartbeatSeconds: number;
  defaultAgentId: string;
  sessionCount: number;
  sessionPath: string;
  channels: HealthChannelEntry[];
  agents: HealthAgentEntry[];
  system: SystemResourceMetrics | null;
};

export type HealthState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  healthLoading: boolean;
  healthError: string | null;
  healthData: HealthData | null;
  healthChannels: Array<{ id: string; status: string }>;
};

type RawHealthResponse = {
  ok?: boolean;
  ts?: number;
  durationMs?: number;
  heartbeatSeconds?: number;
  defaultAgentId?: string;
  channelOrder?: string[];
  channelLabels?: Record<string, string>;
  channels?: Record<
    string,
    {
      configured?: boolean;
      linked?: boolean;
      accounts?: Record<string, unknown>;
    }
  >;
  agents?: Array<{
    agentId: string;
    name?: string;
    isDefault: boolean;
    heartbeat?: { alive?: boolean; ageMs?: number | null };
    sessions?: { count?: number };
  }>;
  sessions?: {
    path?: string;
    count?: number;
  };
  system?: SystemResourceMetrics;
};

export async function loadHealth(state: HealthState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.healthLoading) {
    return;
  }
  state.healthLoading = true;
  state.healthError = null;
  try {
    const raw = await state.client.request<RawHealthResponse | undefined>("health", {});
    if (!raw) {
      return;
    }

    const channelOrder = raw.channelOrder ?? [];
    const channelLabels = raw.channelLabels ?? {};
    const rawChannels = raw.channels ?? {};

    const channels: HealthChannelEntry[] = channelOrder.map((id) => {
      const ch = rawChannels[id];
      return {
        id,
        label: channelLabels[id] ?? id,
        configured: ch?.configured ?? false,
        linked: ch?.linked ?? false,
      };
    });

    // Also build the simple status array for the view
    state.healthChannels = channels.map((ch) => ({
      id: ch.label,
      status: ch.linked ? "connected" : ch.configured ? "warning" : "disconnected",
    }));

    const agents: HealthAgentEntry[] = (raw.agents ?? []).map((a) => ({
      agentId: a.agentId,
      name: a.name,
      isDefault: a.isDefault,
      heartbeatAlive: a.heartbeat?.alive ?? false,
      heartbeatAgeMs: a.heartbeat?.ageMs ?? null,
      sessionCount: a.sessions?.count ?? 0,
    }));

    state.healthData = {
      ok: raw.ok ?? false,
      ts: raw.ts ?? Date.now(),
      durationMs: raw.durationMs ?? 0,
      heartbeatSeconds: raw.heartbeatSeconds ?? 0,
      defaultAgentId: raw.defaultAgentId ?? "",
      sessionCount: raw.sessions?.count ?? 0,
      sessionPath: raw.sessions?.path ?? "",
      channels,
      agents,
      system: raw.system ?? null,
    };
  } catch (err) {
    state.healthError = String(err);
  } finally {
    state.healthLoading = false;
  }
}

export async function loadHealthChannels(_state: HealthState) {
  // Channel data is now extracted from the health response directly.
  // This function is kept for compatibility but is a no-op.
}
