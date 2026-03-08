// Token使用统计服务
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { 
  TokenUsageRecord, 
  DailyTokenUsage, 
  ModelUsageBreakdown,
  ProviderUsageBreakdown,
  UsageQueryParams 
} from '../types/index.js';

const execAsync = promisify(exec);

/**
 * Token使用统计服务
 * 负责收集、聚合和提供token使用数据
 */
export class TokenUsageService {
  private readonly codexbarPath: string;
  private readonly dataDir: string;
  
  constructor() {
    this.codexbarPath = 'codexbar'; // 假设codexbar在PATH中
    this.dataDir = path.join(process.cwd(), 'data', 'token-usage');
    this.ensureDataDir();
  }
  
  /**
   * 确保数据目录存在
   */
  private async ensureDataDir(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
    } catch (error) {
      console.warn('Failed to create data directory:', error);
    }
  }
  
  /**
   * 从CodexBar获取成本数据
   */
  async fetchCodexBarData(provider: 'codex' | 'claude' | 'all' = 'all'): Promise<any[]> {
    try {
      const providers = provider === 'all' ? ['codex', 'claude'] : [provider];
      const allData: any[] = [];
      
      for (const prov of providers) {
        try {
          const { stdout } = await execAsync(
            `${this.codexbarPath} cost --format json --provider ${prov}`,
            { timeout: 30000 }
          );
          
          const data = JSON.parse(stdout);
          if (Array.isArray(data)) {
            // 添加provider信息
            const enrichedData = data.map((item: any) => ({
              ...item,
              provider: prov
            }));
            allData.push(...enrichedData);
          }
        } catch (error) {
          console.warn(`Failed to fetch data for provider ${prov}:`, error);
        }
      }
      
      return allData;
    } catch (error) {
      console.error('Failed to fetch CodexBar data:', error);
      throw new Error(`Failed to fetch token usage data: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * 获取每日token使用统计
   */
  async getDailyTokenUsage(date?: string): Promise<DailyTokenUsage> {
    try {
      const data = await this.fetchCodexBarData();
      const targetDate = date || this.getTodayDate();
      
      // 过滤指定日期的数据
      const dailyData = data.filter((item: any) => {
        const itemDate = item.date;
        return itemDate === targetDate;
      });
      
      if (dailyData.length === 0) {
        return this.createEmptyDailyUsage(targetDate);
      }
      
      // 聚合数据
      return this.aggregateDailyData(dailyData, targetDate);
    } catch (error) {
      console.error('Failed to get daily token usage:', error);
      return this.createEmptyDailyUsage(date || this.getTodayDate());
    }
  }
  
  /**
   * 获取日期范围的token使用
   */
  async getTokenUsageRange(params: UsageQueryParams): Promise<DailyTokenUsage[]> {
    try {
      const data = await this.fetchCodexBarData();
      const { startDate, endDate } = params;
      
      if (!startDate || !endDate) {
        throw new Error('startDate and endDate are required');
      }
      
      // 过滤日期范围
      const filteredData = data.filter((item: any) => {
        const itemDate = item.date;
        return itemDate >= startDate && itemDate <= endDate;
      });
      
      // 按日期分组
      const groupedByDate = this.groupByDate(filteredData);
      
      // 生成每日统计
      const dailyUsages: DailyTokenUsage[] = [];
      for (const [date, dateData] of Object.entries(groupedByDate)) {
        dailyUsages.push(this.aggregateDailyData(dateData, date));
      }
      
      // 按日期排序
      return dailyUsages.sort((a, b) => a.date.localeCompare(b.date));
    } catch (error) {
      console.error('Failed to get token usage range:', error);
      return [];
    }
  }
  
  /**
   * 获取模型使用排行
   */
  async getModelRankings(limit: number = 10, period?: string): Promise<ModelUsageBreakdown[]> {
    try {
      const data = await this.fetchCodexBarData();
      
      // 按模型聚合所有数据
      const modelMap = new Map<string, ModelUsageBreakdown>();
      
      data.forEach((item: any) => {
        const breakdowns = item.modelBreakdowns || [];
        breakdowns.forEach((breakdown: any) => {
          const modelName = breakdown.modelName;
          const cost = breakdown.cost || 0;
          const tokens = breakdown.tokens || 0;
          
          if (!modelName) return;
          
          const existing = modelMap.get(modelName) || {
            model: modelName,
            provider: item.provider || 'unknown',
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            estimatedCost: 0,
            usageCount: 0
          };
          
          // 更新统计
          existing.totalTokens += tokens;
          existing.estimatedCost += cost;
          existing.usageCount += 1;
          
          modelMap.set(modelName, existing);
        });
      });
      
      // 转换为数组并排序
      const rankings = Array.from(modelMap.values())
        .sort((a, b) => b.totalTokens - a.totalTokens)
        .slice(0, limit);
      
      // 计算百分比
      const totalTokens = rankings.reduce((sum, item) => sum + item.totalTokens, 0);
      if (totalTokens > 0) {
        rankings.forEach(item => {
          // 这里可以添加百分比计算，但需要修改类型定义
        });
      }
      
      return rankings;
    } catch (error) {
      console.error('Failed to get model rankings:', error);
      return [];
    }
  }
  
  /**
   * 获取使用趋势
   */
  async getUsageTrend(days: number = 30): Promise<any> {
    try {
      const endDate = this.getTodayDate();
      const startDate = this.subtractDays(endDate, days);
      
      const dailyUsages = await this.getTokenUsageRange({
        startDate,
        endDate
      });
      
      // 生成趋势数据
      const dataPoints = dailyUsages.map(usage => ({
        date: usage.date,
        totalTokens: usage.totalTokens,
        estimatedCost: usage.estimatedCost,
        modelCount: usage.modelBreakdown.length
      }));
      
      // 计算摘要
      const totalTokens = dailyUsages.reduce((sum, usage) => sum + usage.totalTokens, 0);
      const totalCost = dailyUsages.reduce((sum, usage) => sum + usage.estimatedCost, 0);
      
      // 计算增长率（如果有足够数据）
      let growthRate = 0;
      if (dailyUsages.length >= 2) {
        const firstWeek = dailyUsages.slice(0, 7).reduce((sum, usage) => sum + usage.totalTokens, 0);
        const lastWeek = dailyUsages.slice(-7).reduce((sum, usage) => sum + usage.totalTokens, 0);
        if (firstWeek > 0) {
          growthRate = ((lastWeek - firstWeek) / firstWeek) * 100;
        }
      }
      
      // 找到峰值使用
      const peakUsage = dailyUsages.reduce((peak, usage) => {
        return usage.totalTokens > peak.tokens ? 
          { date: usage.date, tokens: usage.totalTokens } : peak;
      }, { date: '', tokens: 0 });
      
      return {
        period: 'daily',
        dataPoints,
        summary: {
          totalTokens,
          totalCost,
          averageDailyTokens: totalTokens / dailyUsages.length,
          averageDailyCost: totalCost / dailyUsages.length,
          growthRate,
          peakUsage
        }
      };
    } catch (error) {
      console.error('Failed to get usage trend:', error);
      return {
        period: 'daily',
        dataPoints: [],
        summary: {
          totalTokens: 0,
          totalCost: 0,
          averageDailyTokens: 0,
          averageDailyCost: 0,
          growthRate: 0,
          peakUsage: { date: '', tokens: 0 }
        }
      };
    }
  }
  
  /**
   * 聚合每日数据
   */
  private aggregateDailyData(data: any[], date: string): DailyTokenUsage {
    const modelMap = new Map<string, ModelUsageBreakdown>();
    const providerMap = new Map<string, ProviderUsageBreakdown>();
    
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;
    let totalCost = 0;
    
    data.forEach(item => {
      const breakdowns = item.modelBreakdowns || [];
      
      breakdowns.forEach((breakdown: any) => {
        const modelName = breakdown.modelName;
        const cost = breakdown.cost || 0;
        const tokens = breakdown.tokens || 0;
        
        if (!modelName) return;
        
        // 更新模型统计
        const modelKey = `${item.provider || 'unknown'}:${modelName}`;
        const modelStats = modelMap.get(modelKey) || {
          model: modelName,
          provider: item.provider || 'unknown',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCost: 0,
          usageCount: 0
        };
        
        modelStats.totalTokens += tokens;
        modelStats.estimatedCost += cost;
        modelStats.usageCount += 1;
        modelMap.set(modelKey, modelStats);
        
        // 更新提供商统计
        const provider = item.provider || 'unknown';
        const providerStats = providerMap.get(provider) || {
          provider,
          totalTokens: 0,
          estimatedCost: 0,
          modelCount: 0
        };
        
        providerStats.totalTokens += tokens;
        providerStats.estimatedCost += cost;
        providerStats.modelCount = modelMap.size;
        providerMap.set(provider, providerStats);
        
        // 更新总计
        totalTokens += tokens;
        totalCost += cost;
      });
    });
    
    return {
      date,
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      estimatedCost: totalCost,
      modelBreakdown: Array.from(modelMap.values()),
      providerBreakdown: Array.from(providerMap.values())
    };
  }
  
  /**
   * 按日期分组数据
   */
  private groupByDate(data: any[]): Record<string, any[]> {
    const grouped: Record<string, any[]> = {};
    
    data.forEach(item => {
      const date = item.date;
      if (!date) return;
      
      if (!grouped[date]) {
        grouped[date] = [];
      }
      grouped[date].push(item);
    });
    
    return grouped;
  }
  
  /**
   * 创建空的每日使用记录
   */
  private createEmptyDailyUsage(date: string): DailyTokenUsage {
    return {
      date,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      modelBreakdown: [],
      providerBreakdown: []
    };
  }
  
  /**
   * 获取今天日期字符串
   */
  private getTodayDate(): string {
    return new Date().toISOString().split('T')[0];
  }
  
  /**
   * 计算减去天数的日期
   */
  private subtractDays(dateStr: string, days: number): string {
    const date = new Date(dateStr);
    date.setDate(date.getDate() - days);
    return date.toISOString().split('T')[0];
  }
  
  /**
   * 测试服务连接
   */
  async testConnection(): Promise<boolean> {
    try {
      await execAsync(`${this.codexbarPath} --version`, { timeout: 5000 });
      return true;
    } catch (error) {
      console.warn('CodexBar not available:', error);
      return false;
    }
  }
}

// 导出单例实例
export const tokenUsageService = new TokenUsageService();