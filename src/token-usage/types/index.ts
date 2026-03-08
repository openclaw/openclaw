// Token使用统计相关类型定义

/**
 * Token使用记录接口
 */
export interface TokenUsageRecord {
  id: string;
  timestamp: Date;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  sessionId?: string;
  userId?: string;
  metadata?: Record<string, any>;
}

/**
 * 每日Token使用统计
 */
export interface DailyTokenUsage {
  date: string; // YYYY-MM-DD格式
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  modelBreakdown: ModelUsageBreakdown[];
  providerBreakdown: ProviderUsageBreakdown[];
}

/**
 * 模型使用明细
 */
export interface ModelUsageBreakdown {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  usageCount: number;
}

/**
 * 提供商使用明细
 */
export interface ProviderUsageBreakdown {
  provider: string;
  totalTokens: number;
  estimatedCost: number;
  modelCount: number;
}

/**
 * Token使用趋势数据
 */
export interface TokenUsageTrend {
  period: 'daily' | 'weekly' | 'monthly';
  dataPoints: TrendDataPoint[];
  summary: TrendSummary;
}

/**
 * 趋势数据点
 */
export interface TrendDataPoint {
  date: string;
  totalTokens: number;
  estimatedCost: number;
  modelCount: number;
}

/**
 * 趋势摘要
 */
export interface TrendSummary {
  totalTokens: number;
  totalCost: number;
  averageDailyTokens: number;
  averageDailyCost: number;
  growthRate: number; // 增长率百分比
  peakUsage: {
    date: string;
    tokens: number;
  };
}

/**
 * 模型使用排行
 */
export interface ModelUsageRanking {
  period: string;
  rankings: ModelRank[];
}

/**
 * 模型排行项
 */
export interface ModelRank {
  rank: number;
  model: string;
  provider: string;
  totalTokens: number;
  estimatedCost: number;
  usageCount: number;
  percentage: number; // 占总使用量的百分比
}

/**
 * API响应格式
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  timestamp: Date;
}

/**
 * 查询参数
 */
export interface UsageQueryParams {
  startDate?: string;
  endDate?: string;
  model?: string;
  provider?: string;
  groupBy?: 'day' | 'week' | 'month' | 'model' | 'provider';
  limit?: number;
  offset?: number;
}

/**
 * 实时更新事件
 */
export interface TokenUsageUpdateEvent {
  type: 'usage_update' | 'daily_summary' | 'threshold_alert';
  timestamp: Date;
  data: any;
}

/**
 * 使用量预警配置
 */
export interface UsageAlertConfig {
  enabled: boolean;
  dailyTokenThreshold?: number;
  dailyCostThreshold?: number;
  notificationChannels: string[];
  recipients: string[];
}

/**
 * 数据导出选项
 */
export interface ExportOptions {
  format: 'json' | 'csv' | 'excel';
  includeDetails: boolean;
  dateRange: {
    start: string;
    end: string;
  };
  filters?: UsageQueryParams;
}