// Token使用统计功能集成
import { integrateTokenUsageApi } from './api/index.js';

/**
 * Token使用统计功能集成配置
 */
export interface TokenUsageIntegrationConfig {
  enabled: boolean;
  apiPrefix?: string;
  requireCodexBar?: boolean;
  dataRetentionDays?: number;
  enableWebSocket?: boolean;
}

/**
 * 默认配置
 */
const defaultConfig: TokenUsageIntegrationConfig = {
  enabled: true,
  apiPrefix: '/api/v1/usage/token',
  requireCodexBar: true,
  dataRetentionDays: 90,
  enableWebSocket: false
};

/**
 * Token使用统计功能集成器
 */
export class TokenUsageIntegrator {
  private config: TokenUsageIntegrationConfig;
  
  constructor(config: Partial<TokenUsageIntegrationConfig> = {}) {
    this.config = { ...defaultConfig, ...config };
  }
  
  /**
   * 集成到Express应用
   */
  integrateToExpress(app: any): void {
    if (!this.config.enabled) {
      console.log('Token usage statistics is disabled');
      return;
    }
    
    try {
      // 集成API路由
      integrateTokenUsageApi(app);
      
      console.log('✅ Token usage statistics API integrated successfully');
      
      // 注册健康检查路由
      this.registerHealthCheck(app);
      
      // 注册管理界面路由（如果前端已构建）
      this.registerAdminRoutes(app);
      
    } catch (error) {
      console.error('❌ Failed to integrate token usage statistics:', error);
      throw error;
    }
  }
  
  /**
   * 注册健康检查路由
   */
  private registerHealthCheck(app: any): void {
    app.get('/admin/token-usage/health', async (req, res) => {
      try {
        // 检查CodexBar是否可用
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        
        await execAsync('codexbar --version', { timeout: 5000 });
        
        res.json({
          status: 'healthy',
          service: 'token-usage-statistics',
          timestamp: new Date().toISOString(),
          dependencies: {
            codexbar: 'available'
          }
        });
      } catch (error) {
        res.status(503).json({
          status: 'unhealthy',
          service: 'token-usage-statistics',
          timestamp: new Date().toISOString(),
          error: 'CodexBar CLI not available',
          details: error instanceof Error ? error.message : String(error)
        });
      }
    });
  }
  
  /**
   * 注册管理界面路由
   */
  private registerAdminRoutes(app: any): void {
    // 管理界面入口
    app.get('/admin/token-usage', (req, res) => {
      res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Token Usage Dashboard - OpenClaw</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              margin: 0;
              padding: 0;
              background: #f8f9fa;
            }
            .container {
              max-width: 1200px;
              margin: 0 auto;
              padding: 2rem;
            }
            .header {
              text-align: center;
              margin-bottom: 2rem;
            }
            .dashboard-container {
              background: white;
              border-radius: 8px;
              padding: 2rem;
              box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Token Usage Statistics</h1>
              <p>Monitor AI token consumption and costs</p>
            </div>
            <div class="dashboard-container">
              <token-usage-dashboard></token-usage-dashboard>
            </div>
          </div>
          <script type="module">
            // 动态导入dashboard组件
            import('/ui/components/token-usage-dashboard.js').then(module => {
              console.log('Token usage dashboard loaded');
            }).catch(error => {
              console.error('Failed to load dashboard:', error);
              document.querySelector('.dashboard-container').innerHTML = 
                '<div style="text-align: center; padding: 3rem; color: #6c757d;">' +
                'Dashboard component failed to load. Please check the console for errors.' +
                '</div>';
            });
          </script>
        </body>
        </html>
      `);
    });
    
    // API文档页面
    app.get('/admin/token-usage/api-docs', (req, res) => {
      res.redirect(`${this.config.apiPrefix}/docs`);
    });
  }
  
  /**
   * 获取配置信息
   */
  getConfig(): TokenUsageIntegrationConfig {
    return { ...this.config };
  }
  
  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<TokenUsageIntegrationConfig>): void {
    this.config = { ...this.config, ...newConfig };
    console.log('Token usage configuration updated:', this.config);
  }
  
  /**
   * 检查系统要求
   */
  async checkRequirements(): Promise<{
    met: boolean;
    requirements: Array<{ name: string; met: boolean; message: string }>;
  }> {
    const requirements = [];
    
    // 检查CodexBar
    if (this.config.requireCodexBar) {
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        
        await execAsync('codexbar --version', { timeout: 5000 });
        requirements.push({
          name: 'CodexBar CLI',
          met: true,
          message: 'CodexBar is available'
        });
      } catch (error) {
        requirements.push({
          name: 'CodexBar CLI',
          met: false,
          message: 'CodexBar not found or not accessible'
        });
      }
    }
    
    // 检查数据目录权限
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      
      const dataDir = path.join(process.cwd(), 'data', 'token-usage');
      await fs.mkdir(dataDir, { recursive: true });
      
      const testFile = path.join(dataDir, '.test-write');
      await fs.writeFile(testFile, 'test');
      await fs.unlink(testFile);
      
      requirements.push({
        name: 'Data directory permissions',
        met: true,
        message: 'Data directory is writable'
      });
    } catch (error) {
      requirements.push({
        name: 'Data directory permissions',
        met: false,
        message: 'Cannot write to data directory'
      });
    }
    
    const allMet = requirements.every(req => req.met);
    
    return {
      met: allMet,
      requirements
    };
  }
}

// 导出默认集成器实例
export const tokenUsageIntegrator = new TokenUsageIntegrator();

// 导出集成函数
export function integrateTokenUsageStatistics(app: any, config?: Partial<TokenUsageIntegrationConfig>): void {
  const integrator = new TokenUsageIntegrator(config);
  integrator.integrateToExpress(app);
}

export default {
  TokenUsageIntegrator,
  tokenUsageIntegrator,
  integrateTokenUsageStatistics
};