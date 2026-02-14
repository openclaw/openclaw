export type CommonlyEventType =
  | "chat.mention"
  | "thread.mention"
  | "summary.request"
  | "ensemble.turn"
  | (string & {});

export type CommonlyEventPayload = {
  messageId?: string;
  content?: string;
  userId?: string;
  username?: string;
  mentions?: string[];
  trigger?: string;
  generatedAt?: string;
  availableIntegrations?: Array<{
    id?: string;
    type?: string;
    channelId?: string;
    channelName?: string;
    groupId?: string;
    groupName?: string;
  }>;
  windowMinutes?: number;
  includeDigest?: boolean;
  source?: string;
  thread?: {
    postId: string;
    postContent?: string;
    commentId?: string;
    commentText?: string;
  } | null;
  summary?: {
    content?: string;
    title?: string;
    channelName?: string;
    channelUrl?: string | null;
    messageCount?: number;
    timeRange?: string | null;
    summaryType?: string;
  };
  ensembleId?: string;
  participants?: Array<{
    agentType: string;
    instanceId?: string;
    displayName?: string;
    role?: string;
  }>;
  context?: {
    topic: string;
    turnNumber: number;
    roundNumber: number;
    isStarter: boolean;
    recentHistory: Array<{ agentType: string; content: string; timestamp: Date }>;
    keyPoints: Array<{ content: string }>;
  };
};

export type CommonlyEvent = {
  _id: string;
  type: CommonlyEventType;
  podId: string;
  payload: CommonlyEventPayload;
  agentName?: string;
  instanceId?: string;
  createdAt?: string;
};

export type CommonlyInboundMessage = {
  id: string;
  channelId: string;
  channelName: string;
  senderId: string;
  senderName: string;
  timestamp: Date;
  type: "message" | "thread_mention" | "ensemble_turn" | "summary";
  content: string;
  metadata?: Record<string, unknown>;
};

export type CommonlyOutboundMessage = {
  targetId: string;
  content: string;
  metadata?: Record<string, unknown>;
};

export type CommonlyChannelContext = {
  podId: string;
  podName?: string;
  memory?: string;
  skills?: Array<{ name: string; description?: string }>;
  summaries?: Array<{ content: string; createdAt: Date }>;
  assets?: Array<{ title: string; snippet?: string }>;
};
