// Token使用统计API主入口
import { Router } from 'express';
import tokenUsageRoutes from './routes.js';

/**
 * 创建Token使用统计API路由器
 */
export function createTokenUsageApiRouter(): Router {
  const router = Router();
  
  // API版本前缀
  const API_PREFIX = '/api/v1/usage/token';
  
  // 注册路由
  router.use(API_PREFIX, tokenUsageRoutes);
  
  // API文档端点
  router.get(`${API_PREFIX}/docs`, (req, res) => {
    res.json({
      name: 'Token Usage Statistics API',
      version: '1.0.0',
      description: 'API for tracking and analyzing token usage across AI models',
      endpoints: [
        {
          method: 'GET',
          path: `${API_PREFIX}/health`,
          description: 'Health check endpoint',
          parameters: []
        },
        {
          method: 'GET',
          path: `${API_PREFIX}/daily`,
          description: 'Get daily token usage statistics',
          parameters: [
            { name: 'date', type: 'string', optional: true, description: 'Date in YYYY-MM-DD format' }
          ]
        },
        {
          method: 'GET',
          path: `${API_PREFIX}/range`,
          description: 'Get token usage for a date range',
          parameters: [
            { name: 'startDate', type: 'string', optional: false, description: 'Start date in YYYY-MM-DD format' },
            { name: 'endDate', type: 'string', optional: false, description: 'End date in YYYY-MM-DD format' },
            { name: 'model', type: 'string', optional: true, description: 'Filter by model name' },
            { name: 'provider', type: 'string', optional: true, description: 'Filter by provider (codex/claude)' },
            { name: 'groupBy', type: 'string', optional: true, description: 'Group by day/week/month/model/provider' },
            { name: 'limit', type: 'number', optional: true, description: 'Limit number of results' },
            { name: 'offset', type: 'number', optional: true, description: 'Offset for pagination' }
          ]
        },
        {
          method: 'GET',
          path: `${API_PREFIX}/models/rankings`,
          description: 'Get model usage rankings',
          parameters: [
            { name: 'limit', type: 'number', optional: true, description: 'Number of top models to return (default: 10)' },
            { name: 'period', type: 'string', optional: true, description: 'Time period for rankings' }
          ]
        },
        {
          method: 'GET',
          path: `${API_PREFIX}/trend`,
          description: 'Get token usage trend',
          parameters: [
            { name: 'days', type: 'number', optional: true, description: 'Number of days to analyze (default: 30)' }
          ]
        },
        {
          method: 'GET',
          path: `${API_PREFIX}/summary`,
          description: 'Get usage summary',
          parameters: [
            { name: 'period', type: 'string', optional: true, description: 'Summary period (7d, 30d, 90d)' }
          ]
        },
        {
          method: 'GET',
          path: `${API_PREFIX}/export`,
          description: 'Export usage data',
          parameters: [
            { name: 'format', type: 'string', optional: true, description: 'Export format (json, csv)' },
            { name: 'startDate', type: 'string', optional: false, description: 'Start date in YYYY-MM-DD format' },
            { name: 'endDate', type: 'string', optional: false, description: 'End date in YYYY-MM-DD format' }
          ]
        }
      ],
      dataSources: [
        {
          name: 'CodexBar CLI',
          description: 'Primary data source for token usage and cost data',
          required: true
        }
      ],
      examples: {
        getDailyUsage: `${API_PREFIX}/daily?date=2024-01-15`,
        getRange: `${API_PREFIX}/range?startDate=2024-01-01&endDate=2024-01-31`,
        getModelRankings: `${API_PREFIX}/models/rankings?limit=5`,
        getTrend: `${API_PREFIX}/trend?days=7`,
        getSummary: `${API_PREFIX}/summary?period=30d`
      }
    });
  });
  
  // 404处理
  router.use(`${API_PREFIX}/*`, (req, res) => {
    res.status(404).json({
      success: false,
      error: 'Endpoint not found',
      message: `The requested endpoint ${req.originalUrl} does not exist`,
      timestamp: new Date()
    });
  });
  
  // 错误处理中间件
  router.use((error: any, req: any, res: any, next: any) => {
    console.error('Token usage API error:', error);
    
    res.status(error.status || 500).json({
      success: false,
      error: error.name || 'InternalServerError',
      message: error.message || 'An unexpected error occurred',
      timestamp: new Date(),
      path: req.path
    });
  });
  
  return router;
}

/**
 * 将Token使用API集成到现有Express应用
 */
export function integrateTokenUsageApi(app: any): void {
  const tokenUsageRouter = createTokenUsageApiRouter();
  app.use(tokenUsageRouter);
  
  console.log('Token usage statistics API integrated successfully');
}

// 导出默认配置
export default {
  createTokenUsageApiRouter,
  integrateTokenUsageApi
};