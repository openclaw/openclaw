/**
 * Analytics Repository
 *
 * Data access layer for usage statistics and metrics.
 */

import { query, queryOne, queryMany } from '../client.js';

// ============================================================================
// TYPES
// ============================================================================

export interface AgentStatsHourly {
  id: string;
  agentId: string;
  customerId: string;
  hourBucket: Date;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  avgResponseTimeMs: number | null;
  minResponseTimeMs: number | null;
  maxResponseTimeMs: number | null;
  errorCount: number;
  timeoutCount: number;
  uniqueUsers: number;
  newUsers: number;
}

export interface CustomerStatsDaily {
  id: string;
  customerId: string;
  dayBucket: Date;
  totalAgents: number;
  activeAgents: number;
  totalMessages: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  totalUniqueUsers: number;
}

export interface MessageLogEntry {
  id: string;
  agentId: string;
  customerId: string;
  direction: 'inbound' | 'outbound';
  channel: string;
  peerId: string | null;
  contentPreview: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  responseTimeMs: number | null;
  status: 'success' | 'error' | 'timeout';
  errorMessage: string | null;
  createdAt: Date;
}

export interface UsageSummary {
  period: 'hour' | 'day' | 'week' | 'month';
  totalMessages: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  avgResponseTime: number | null;
  errorRate: number;
  uniqueUsers: number;
  activeAgents: number;
}

export interface AgentUsageSummary {
  agentId: string;
  agentName: string;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  avgResponseTime: number | null;
  errorRate: number;
  uniqueUsers: number;
}

// ============================================================================
// MESSAGE LOGGING
// ============================================================================

export async function logMessage(input: {
  agentId: string;
  customerId: string;
  direction: 'inbound' | 'outbound';
  channel: string;
  peerId?: string;
  contentPreview?: string;
  inputTokens?: number;
  outputTokens?: number;
  responseTimeMs?: number;
  status?: 'success' | 'error' | 'timeout';
  errorMessage?: string;
}): Promise<void> {
  await query(
    `INSERT INTO message_log (
      agent_id, customer_id, direction, channel, peer_id, content_preview,
      input_tokens, output_tokens, response_time_ms, status, error_message
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.agentId,
      input.customerId,
      input.direction,
      input.channel,
      input.peerId || null,
      input.contentPreview?.substring(0, 500) || null,
      input.inputTokens || null,
      input.outputTokens || null,
      input.responseTimeMs || null,
      input.status || 'success',
      input.errorMessage || null,
    ]
  );
}

export async function getRecentMessages(
  customerId: string,
  options?: {
    agentId?: string;
    limit?: number;
    offset?: number;
  }
): Promise<{ messages: MessageLogEntry[]; total: number }> {
  const conditions = ['customer_id = $1'];
  const params: unknown[] = [customerId];
  let idx = 2;

  if (options?.agentId) {
    conditions.push(`agent_id = $${idx++}`);
    params.push(options.agentId);
  }

  const limit = options?.limit || 50;
  const offset = options?.offset || 0;

  const [countResult, messages] = await Promise.all([
    queryOne(
      `SELECT COUNT(*) as count FROM message_log WHERE ${conditions.join(' AND ')}`,
      params
    ),
    queryMany(
      `SELECT * FROM message_log
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    ),
  ]);

  return {
    messages: messages.map((row) => ({
      id: row.id as string,
      agentId: row.agent_id as string,
      customerId: row.customer_id as string,
      direction: row.direction as 'inbound' | 'outbound',
      channel: row.channel as string,
      peerId: row.peer_id as string | null,
      contentPreview: row.content_preview as string | null,
      inputTokens: row.input_tokens as number | null,
      outputTokens: row.output_tokens as number | null,
      responseTimeMs: row.response_time_ms as number | null,
      status: row.status as 'success' | 'error' | 'timeout',
      errorMessage: row.error_message as string | null,
      createdAt: new Date(row.created_at as string),
    })),
    total: parseInt((countResult?.count as string) || '0', 10),
  };
}

// ============================================================================
// STATS AGGREGATION
// ============================================================================

export async function recordAgentStats(input: {
  agentId: string;
  customerId: string;
  messageCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  responseTimeMs?: number;
  isError?: boolean;
  isTimeout?: boolean;
  userId?: string;
  isNewUser?: boolean;
}): Promise<void> {
  const hourBucket = new Date();
  hourBucket.setMinutes(0, 0, 0);

  await query(
    `INSERT INTO agent_stats_hourly (
      agent_id, customer_id, hour_bucket, message_count, input_tokens, output_tokens,
      avg_response_time_ms, min_response_time_ms, max_response_time_ms,
      error_count, timeout_count, unique_users, new_users
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7, $8, $9, $10, $11)
    ON CONFLICT (agent_id, hour_bucket) DO UPDATE SET
      message_count = agent_stats_hourly.message_count + $4,
      input_tokens = agent_stats_hourly.input_tokens + $5,
      output_tokens = agent_stats_hourly.output_tokens + $6,
      avg_response_time_ms = CASE
        WHEN $7 IS NOT NULL THEN
          (COALESCE(agent_stats_hourly.avg_response_time_ms, 0) * agent_stats_hourly.message_count + $7) /
          (agent_stats_hourly.message_count + 1)
        ELSE agent_stats_hourly.avg_response_time_ms
      END,
      min_response_time_ms = LEAST(agent_stats_hourly.min_response_time_ms, $7),
      max_response_time_ms = GREATEST(agent_stats_hourly.max_response_time_ms, $7),
      error_count = agent_stats_hourly.error_count + $8,
      timeout_count = agent_stats_hourly.timeout_count + $9,
      unique_users = agent_stats_hourly.unique_users + $10,
      new_users = agent_stats_hourly.new_users + $11`,
    [
      input.agentId,
      input.customerId,
      hourBucket,
      input.messageCount || 1,
      input.inputTokens || 0,
      input.outputTokens || 0,
      input.responseTimeMs || null,
      input.isError ? 1 : 0,
      input.isTimeout ? 1 : 0,
      input.userId ? 1 : 0,
      input.isNewUser ? 1 : 0,
    ]
  );
}

export async function aggregateDailyStats(date: Date): Promise<void> {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  await query(
    `INSERT INTO customer_stats_daily (
      customer_id, day_bucket, total_agents, active_agents, total_messages,
      total_input_tokens, total_output_tokens, estimated_cost_usd, total_unique_users
    )
    SELECT
      ash.customer_id,
      $1::date as day_bucket,
      COUNT(DISTINCT a.id) as total_agents,
      COUNT(DISTINCT CASE WHEN ash.message_count > 0 THEN a.id END) as active_agents,
      SUM(ash.message_count) as total_messages,
      SUM(ash.input_tokens) as total_input_tokens,
      SUM(ash.output_tokens) as total_output_tokens,
      SUM(
        ash.input_tokens * 0.003 / 1000 + ash.output_tokens * 0.015 / 1000
      ) as estimated_cost_usd,
      SUM(ash.unique_users) as total_unique_users
    FROM agent_stats_hourly ash
    JOIN agents a ON ash.agent_id = a.id
    WHERE ash.hour_bucket >= $1 AND ash.hour_bucket < $2
    GROUP BY ash.customer_id
    ON CONFLICT (customer_id, day_bucket) DO UPDATE SET
      total_agents = EXCLUDED.total_agents,
      active_agents = EXCLUDED.active_agents,
      total_messages = EXCLUDED.total_messages,
      total_input_tokens = EXCLUDED.total_input_tokens,
      total_output_tokens = EXCLUDED.total_output_tokens,
      estimated_cost_usd = EXCLUDED.estimated_cost_usd,
      total_unique_users = EXCLUDED.total_unique_users`,
    [dayStart, dayEnd]
  );
}

// ============================================================================
// USAGE QUERIES
// ============================================================================

export async function getCustomerUsageSummary(
  customerId: string,
  period: 'hour' | 'day' | 'week' | 'month'
): Promise<UsageSummary> {
  let interval: string;
  switch (period) {
    case 'hour':
      interval = '1 hour';
      break;
    case 'day':
      interval = '1 day';
      break;
    case 'week':
      interval = '7 days';
      break;
    case 'month':
      interval = '30 days';
      break;
  }

  const result = await queryOne(
    `SELECT
      COALESCE(SUM(message_count), 0) as total_messages,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      AVG(avg_response_time_ms) as avg_response_time,
      CASE WHEN SUM(message_count) > 0
        THEN SUM(error_count)::float / SUM(message_count) * 100
        ELSE 0
      END as error_rate,
      COALESCE(SUM(unique_users), 0) as unique_users,
      COUNT(DISTINCT agent_id) as active_agents
    FROM agent_stats_hourly
    WHERE customer_id = $1 AND hour_bucket >= NOW() - $2::interval`,
    [customerId, interval]
  );

  const inputTokens = parseInt((result?.total_input_tokens as string) || '0', 10);
  const outputTokens = parseInt((result?.total_output_tokens as string) || '0', 10);
  const totalCost = (inputTokens * 0.003 + outputTokens * 0.015) / 1000;

  return {
    period,
    totalMessages: parseInt((result?.total_messages as string) || '0', 10),
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
    totalCost,
    avgResponseTime: result?.avg_response_time
      ? parseFloat(result.avg_response_time as string)
      : null,
    errorRate: parseFloat((result?.error_rate as string) || '0'),
    uniqueUsers: parseInt((result?.unique_users as string) || '0', 10),
    activeAgents: parseInt((result?.active_agents as string) || '0', 10),
  };
}

export async function getAgentUsageSummary(
  customerId: string,
  period: 'hour' | 'day' | 'week' | 'month'
): Promise<AgentUsageSummary[]> {
  let interval: string;
  switch (period) {
    case 'hour':
      interval = '1 hour';
      break;
    case 'day':
      interval = '1 day';
      break;
    case 'week':
      interval = '7 days';
      break;
    case 'month':
      interval = '30 days';
      break;
  }

  const result = await queryMany(
    `SELECT
      ash.agent_id,
      a.name as agent_name,
      COALESCE(SUM(ash.message_count), 0) as message_count,
      COALESCE(SUM(ash.input_tokens), 0) as input_tokens,
      COALESCE(SUM(ash.output_tokens), 0) as output_tokens,
      AVG(ash.avg_response_time_ms) as avg_response_time,
      CASE WHEN SUM(ash.message_count) > 0
        THEN SUM(ash.error_count)::float / SUM(ash.message_count) * 100
        ELSE 0
      END as error_rate,
      COALESCE(SUM(ash.unique_users), 0) as unique_users
    FROM agent_stats_hourly ash
    JOIN agents a ON ash.agent_id = a.id
    WHERE ash.customer_id = $1 AND ash.hour_bucket >= NOW() - $2::interval
    GROUP BY ash.agent_id, a.name
    ORDER BY message_count DESC`,
    [customerId, interval]
  );

  return result.map((row) => {
    const inputTokens = parseInt((row.input_tokens as string) || '0', 10);
    const outputTokens = parseInt((row.output_tokens as string) || '0', 10);
    return {
      agentId: row.agent_id as string,
      agentName: row.agent_name as string,
      messageCount: parseInt((row.message_count as string) || '0', 10),
      inputTokens,
      outputTokens,
      cost: (inputTokens * 0.003 + outputTokens * 0.015) / 1000,
      avgResponseTime: row.avg_response_time
        ? parseFloat(row.avg_response_time as string)
        : null,
      errorRate: parseFloat((row.error_rate as string) || '0'),
      uniqueUsers: parseInt((row.unique_users as string) || '0', 10),
    };
  });
}

export async function getUsageTimeline(
  customerId: string,
  agentId: string | null,
  period: 'hour' | 'day' | 'week' | 'month',
  granularity: 'hour' | 'day'
): Promise<
  Array<{
    bucket: Date;
    messageCount: number;
    inputTokens: number;
    outputTokens: number;
    errorCount: number;
  }>
> {
  let interval: string;
  switch (period) {
    case 'hour':
      interval = '1 hour';
      break;
    case 'day':
      interval = '1 day';
      break;
    case 'week':
      interval = '7 days';
      break;
    case 'month':
      interval = '30 days';
      break;
  }

  const conditions = ['customer_id = $1', 'hour_bucket >= NOW() - $2::interval'];
  const params: unknown[] = [customerId, interval];

  if (agentId) {
    conditions.push('agent_id = $3');
    params.push(agentId);
  }

  const groupBy = granularity === 'hour' ? 'hour_bucket' : 'DATE(hour_bucket)';

  const result = await queryMany(
    `SELECT
      ${groupBy} as bucket,
      SUM(message_count) as message_count,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(error_count) as error_count
    FROM agent_stats_hourly
    WHERE ${conditions.join(' AND ')}
    GROUP BY ${groupBy}
    ORDER BY bucket`,
    params
  );

  return result.map((row) => ({
    bucket: new Date(row.bucket as string),
    messageCount: parseInt((row.message_count as string) || '0', 10),
    inputTokens: parseInt((row.input_tokens as string) || '0', 10),
    outputTokens: parseInt((row.output_tokens as string) || '0', 10),
    errorCount: parseInt((row.error_count as string) || '0', 10),
  }));
}

// ============================================================================
// PLATFORM STATS (Admin)
// ============================================================================

export async function getPlatformStats(): Promise<{
  totalCustomers: number;
  totalAgents: number;
  runningAgents: number;
  totalMessages24h: number;
  totalTokens24h: number;
  estimatedRevenue24h: number;
}> {
  const [customersResult, agentsResult, messagesResult] = await Promise.all([
    queryOne(`SELECT COUNT(*) as count FROM customers WHERE status = 'active'`),
    queryOne(
      `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'running') as running
       FROM agents`
    ),
    queryOne(
      `SELECT
        COALESCE(SUM(message_count), 0) as messages,
        COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
       FROM agent_stats_hourly
       WHERE hour_bucket >= NOW() - INTERVAL '24 hours'`
    ),
  ]);

  const inputTokens = parseInt((messagesResult?.tokens as string) || '0', 10) / 2;
  const outputTokens = inputTokens;

  return {
    totalCustomers: parseInt((customersResult?.count as string) || '0', 10),
    totalAgents: parseInt((agentsResult?.total as string) || '0', 10),
    runningAgents: parseInt((agentsResult?.running as string) || '0', 10),
    totalMessages24h: parseInt((messagesResult?.messages as string) || '0', 10),
    totalTokens24h: parseInt((messagesResult?.tokens as string) || '0', 10),
    estimatedRevenue24h: (inputTokens * 0.003 + outputTokens * 0.015) / 1000,
  };
}

// ============================================================================
// CLEANUP
// ============================================================================

export async function cleanupOldMessageLogs(retentionDays: number = 7): Promise<number> {
  const result = await query(
    `DELETE FROM message_log WHERE created_at < NOW() - $1::interval`,
    [`${retentionDays} days`]
  );
  return result.rowCount ?? 0;
}

export async function cleanupOldHourlyStats(retentionDays: number = 90): Promise<number> {
  const result = await query(
    `DELETE FROM agent_stats_hourly WHERE hour_bucket < NOW() - $1::interval`,
    [`${retentionDays} days`]
  );
  return result.rowCount ?? 0;
}
