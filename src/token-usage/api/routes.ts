// Token使用统计API路由
import { Router } from 'express';
import { tokenUsageService } from '../services/TokenUsageService.js';
import { ApiResponse, UsageQueryParams } from '../types/index.js';

const router = Router();

/**
 * 创建API响应
 */
function createApiResponse<T>(success: boolean, data?: T, error?: string, message?: string): ApiResponse<T> {
  return {
    success,
    data,
    error,
    message,
    timestamp: new Date()
  };
}

/**
 * 健康检查端点
 */
router.get('/health', async (req, res) => {
  try {
    const isHealthy = await tokenUsageService.testConnection();
    
    if (isHealthy) {
      res.json(createApiResponse(true, { status: 'healthy' }, undefined, 'Token usage service is healthy'));
    } else {
      res.status(503).json(
        createApiResponse(false, undefined, 'Service unavailable', 'CodexBar CLI is not available')
      );
    }
  } catch (error) {
    res.status(500).json(
      createApiResponse(false, undefined, 'Internal server error', error instanceof Error ? error.message : String(error))
    );
  }
});

/**
 * 获取每日token使用统计
 */
router.get('/daily', async (req, res) => {
  try {
    const { date } = req.query;
    
    const dailyUsage = await tokenUsageService.getDailyTokenUsage(
      typeof date === 'string' ? date : undefined
    );
    
    res.json(createApiResponse(true, dailyUsage, undefined, 'Daily token usage retrieved successfully'));
  } catch (error) {
    res.status(500).json(
      createApiResponse(false, undefined, 'Failed to retrieve daily usage', error instanceof Error ? error.message : String(error))
    );
  }
});

/**
 * 获取日期范围的token使用
 */
router.get('/range', async (req, res) => {
  try {
    const { startDate, endDate, model, provider, groupBy, limit, offset } = req.query;
    
    const params: UsageQueryParams = {
      startDate: typeof startDate === 'string' ? startDate : undefined,
      endDate: typeof endDate === 'string' ? endDate : undefined,
      model: typeof model === 'string' ? model : undefined,
      provider: typeof provider === 'string' ? provider : undefined,
      groupBy: typeof groupBy === 'string' ? groupBy as any : undefined,
      limit: typeof limit === 'string' ? parseInt(limit, 10) : undefined,
      offset: typeof offset === 'string' ? parseInt(offset, 10) : undefined
    };
    
    const usageRange = await tokenUsageService.getTokenUsageRange(params);
    
    res.json(createApiResponse(true, usageRange, undefined, 'Token usage range retrieved successfully'));
  } catch (error) {
    res.status(500).json(
      createApiResponse(false, undefined, 'Failed to retrieve usage range', error instanceof Error ? error.message : String(error))
    );
  }
});

/**
 * 获取模型使用排行
 */
router.get('/models/rankings', async (req, res) => {
  try {
    const { limit, period } = req.query;
    
    const rankingsLimit = typeof limit === 'string' ? parseInt(limit, 10) : 10;
    const rankingsPeriod = typeof period === 'string' ? period : undefined;
    
    const rankings = await tokenUsageService.getModelRankings(rankingsLimit, rankingsPeriod);
    
    res.json(createApiResponse(true, rankings, undefined, 'Model rankings retrieved successfully'));
  } catch (error) {
    res.status(500).json(
      createApiResponse(false, undefined, 'Failed to retrieve model rankings', error instanceof Error ? error.message : String(error))
    );
  }
});

/**
 * 获取使用趋势
 */
router.get('/trend', async (req, res) => {
  try {
    const { days } = req.query;
    
    const trendDays = typeof days === 'string' ? parseInt(days, 10) : 30;
    
    if (trendDays < 1 || trendDays > 365) {
      res.status(400).json(
        createApiResponse(false, undefined, 'Invalid days parameter', 'Days must be between 1 and 365')
      );
      return;
    }
    
    const trend = await tokenUsageService.getUsageTrend(trendDays);
    
    res.json(createApiResponse(true, trend, undefined, 'Usage trend retrieved successfully'));
  } catch (error) {
    res.status(500).json(
      createApiResponse(false, undefined, 'Failed to retrieve usage trend', error instanceof Error ? error.message : String(error))
    );
  }
});

/**
 * 获取使用摘要
 */
router.get('/summary', async (req, res) => {
  try {
    const { period } = req.query;
    const summaryPeriod = typeof period === 'string' ? period : '30d';
    
    // 获取今日使用
    const todayUsage = await tokenUsageService.getDailyTokenUsage();
    
    // 获取趋势数据（用于计算平均值等）
    const trendDays = summaryPeriod === '7d' ? 7 : summaryPeriod === '30d' ? 30 : 90;
    const trend = await tokenUsageService.getUsageTrend(trendDays);
    
    // 获取模型排行
    const rankings = await tokenUsageService.getModelRankings(5);
    
    const summary = {
      today: {
        totalTokens: todayUsage.totalTokens,
        estimatedCost: todayUsage.estimatedCost,
        modelCount: todayUsage.modelBreakdown.length
      },
      period: {
        totalTokens: trend.summary.totalTokens,
        totalCost: trend.summary.totalCost,
        averageDailyTokens: trend.summary.averageDailyTokens,
        averageDailyCost: trend.summary.averageDailyCost,
        growthRate: trend.summary.growthRate
      },
      topModels: rankings,
      peakUsage: trend.summary.peakUsage
    };
    
    res.json(createApiResponse(true, summary, undefined, 'Usage summary retrieved successfully'));
  } catch (error) {
    res.status(500).json(
      createApiResponse(false, undefined, 'Failed to retrieve usage summary', error instanceof Error ? error.message : String(error))
    );
  }
});

/**
 * 导出使用数据
 */
router.get('/export', async (req, res) => {
  try {
    const { format, startDate, endDate } = req.query;
    
    const exportFormat = typeof format === 'string' ? format : 'json';
    const exportStartDate = typeof startDate === 'string' ? startDate : undefined;
    const exportEndDate = typeof endDate === 'string' ? endDate : undefined;
    
    if (!exportStartDate || !exportEndDate) {
      res.status(400).json(
        createApiResponse(false, undefined, 'Missing date range', 'startDate and endDate are required for export')
      );
      return;
    }
    
    // 获取数据
    const usageData = await tokenUsageService.getTokenUsageRange({
      startDate: exportStartDate,
      endDate: exportEndDate
    });
    
    // 根据格式处理数据
    let contentType: string;
    let data: string;
    
    switch (exportFormat) {
      case 'csv':
        contentType = 'text/csv';
        data = convertToCSV(usageData);
        break;
      case 'json':
      default:
        contentType = 'application/json';
        data = JSON.stringify(usageData, null, 2);
        break;
    }
    
    // 设置响应头
    const filename = `token-usage-${exportStartDate}-to-${exportEndDate}.${exportFormat}`;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    res.send(data);
  } catch (error) {
    res.status(500).json(
      createApiResponse(false, undefined, 'Failed to export usage data', error instanceof Error ? error.message : String(error))
    );
  }
});

/**
 * 将数据转换为CSV格式
 */
function convertToCSV(data: any[]): string {
  if (data.length === 0) return '';
  
  // 提取所有可能的字段
  const fields = new Set<string>();
  data.forEach(item => {
    Object.keys(item).forEach(key => fields.add(key));
  });
  
  const fieldArray = Array.from(fields);
  
  // 创建CSV头部
  const headers = fieldArray.join(',');
  const rows = data.map(item => {
    return fieldArray.map(field => {
      const value = item[field];
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return `"${String(value).replace(/"/g, '""')}"`;
    }).join(',');
  });
  
  return [headers, ...rows].join('\n');
}

export default router;