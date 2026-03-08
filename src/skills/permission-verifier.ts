/**
 * 技能权限验证模块
 * 
 * 支持：
 * - 组织级技能授权验证
 * - 试用期验证
 * - 运行时权限检查
 */

import type { ClawForgeRuntimeConfig } from '../config/clawforge-types.js';

/**
 * 技能权限信息
 */
export interface SkillPermission {
  skillId: string;
  skillName: string;
  authorized: boolean;
  reason?: string;
  
  // 授权详情
  orgId: string;
  userId: string;
  
  // 试用期信息
  trial?: {
    enabled: boolean;
    expiresAt: number;  // 时间戳
    remainingUses?: number;
  };
  
  // 购买信息
  purchase?: {
    purchasedAt: number;
    expiresAt?: number;  // 永久为 undefined
    licenseType: 'permanent' | 'subscription' | 'trial';
  };
}

/**
 * 技能元数据
 */
export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  
  // 权限配置
  requiresPermission: boolean;
  trialPeriodDays?: number;
  trialMaxUses?: number;
  
  // 定价信息
  pricing?: {
    type: 'free' | 'paid' | 'subscription';
    price?: number;
    currency?: string;
  };
}

/**
 * 技能权限验证器
 */
export class SkillPermissionVerifier {
  private config: ClawForgeRuntimeConfig;
  private permissionCache: Map<string, SkillPermission> = new Map();
  private cacheTTL: number = 5 * 60 * 1000;  // 5 分钟缓存

  constructor(config: ClawForgeRuntimeConfig) {
    this.config = config;
  }

  /**
   * 验证技能权限
   */
  async verifyPermission(skillId: string): Promise<SkillPermission> {
    const cacheKey = `${skillId}:${this.config.orgId}:${this.config.userId}`;
    
    // 检查缓存
    const cached = this.permissionCache.get(cacheKey);
    if (cached && !this.isCacheExpired(cached)) {
      return cached;
    }

    try {
      // 1. 从 ClawForge 平台获取技能权限
      const permission = await this.fetchPermissionFromPlatform(skillId);
      
      // 2. 缓存结果
      this.permissionCache.set(cacheKey, permission);
      
      return permission;
    } catch (error) {
      console.error(`[SkillPermission] 验证失败 ${skillId}:`, error);
      
      // 失败时返回未授权
      return {
        skillId,
        skillName: skillId,
        authorized: false,
        reason: '权限验证失败',
        orgId: this.config.orgId,
        userId: this.config.userId,
      };
    }
  }

  /**
   * 从平台获取权限信息
   */
  private async fetchPermissionFromPlatform(skillId: string): Promise<SkillPermission> {
    // TODO: 实际实现时调用 ClawForge 平台 API
    // const response = await fetch(`${platformUrl}/api/skills/${skillId}/permission`, {
    //   headers: {
    //     'Authorization': `Bearer ${this.config.apiKeys.llm}`,
    //     'X-Org-ID': this.config.orgId,
    //     'X-User-ID': this.config.userId,
    //   }
    // });
    
    // 模拟实现（用于开发测试）
    console.log(`[SkillPermission] 验证技能：${skillId} (org: ${this.config.orgId})`);
    
    // 示例：假设所有技能都授权（开发模式）
    return {
      skillId,
      skillName: skillId,
      authorized: true,
      orgId: this.config.orgId,
      userId: this.config.userId,
    };
  }

  /**
   * 检查缓存是否过期
   */
  private isCacheExpired(permission: SkillPermission): boolean {
    // 简单实现：总是认为缓存有效
    // 实际应该记录缓存时间并检查 TTL
    return false;
  }

  /**
   * 验证试用期
   */
  private verifyTrial(
    skill: SkillMetadata,
    permission: SkillPermission
  ): boolean {
    if (!permission.trial || !permission.trial.enabled) {
      return true;  // 没有试用期限制
    }

    const now = Date.now();
    
    // 检查是否过期
    if (now > permission.trial.expiresAt) {
      permission.authorized = false;
      permission.reason = '试用期已过期';
      return false;
    }

    // 检查剩余使用次数
    if (
      permission.trial.remainingUses !== undefined &&
      permission.trial.remainingUses <= 0
    ) {
      permission.authorized = false;
      permission.reason = '试用次数已用完';
      return false;
    }

    return true;
  }

  /**
   * 批量验证技能权限
   */
  async verifyPermissions(skillIds: string[]): Promise<Map<string, SkillPermission>> {
    const results = new Map<string, SkillPermission>();
    
    await Promise.all(
      skillIds.map(async (skillId) => {
        const permission = await this.verifyPermission(skillId);
        results.set(skillId, permission);
      })
    );
    
    return results;
  }

  /**
   * 过滤已授权的技能列表
   */
  async filterAuthorizedSkills(
    skills: SkillMetadata[]
  ): Promise<SkillMetadata[]> {
    const authorized: SkillMetadata[] = [];
    
    for (const skill of skills) {
      const permission = await this.verifyPermission(skill.id);
      
      if (permission.authorized) {
        authorized.push(skill);
      } else {
        console.log(
          `[SkillPermission] 技能未授权：${skill.name} (${permission.reason})`
        );
      }
    }
    
    return authorized;
  }

  /**
   * 记录技能使用（用于试用期计数）
   */
  async recordUsage(skillId: string): Promise<void> {
    // TODO: 调用平台 API 记录使用次数
    console.log(`[SkillPermission] 记录使用：${skillId}`);
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.permissionCache.clear();
    console.log('[SkillPermission] 缓存已清除');
  }

  /**
   * 清除单个技能的缓存
   */
  clearCacheForSkill(skillId: string): void {
    const cacheKey = `${skillId}:${this.config.orgId}:${this.config.userId}`;
    this.permissionCache.delete(cacheKey);
  }
}

/**
 * 技能权限验证中间件
 * 
 * 用于在技能工具调用前进行权限检查
 */
export function createSkillPermissionMiddleware(verifier: SkillPermissionVerifier) {
  return async (
    skillId: string,
    toolName: string,
    next: () => Promise<any>
  ) => {
    // 验证权限
    const permission = await verifier.verifyPermission(skillId);
    
    if (!permission.authorized) {
      throw new Error(
        `技能 ${skillId} 未授权：${permission.reason}`
      );
    }
    
    // 记录使用
    await verifier.recordUsage(skillId);
    
    // 执行工具
    return next();
  };
}

/**
 * 加载组织级技能
 */
export async function loadOrgSkills(
  orgId: string,
  skillsDirectory: string
): Promise<SkillMetadata[]> {
  // TODO: 从组织技能目录加载
  // 实际实现时应该：
  // 1. 从 /storage/{orgId}/skills/ 目录加载
  // 2. 解析每个技能的 metadata.json
  // 3. 返回技能列表
  
  console.log(`[SkillPermission] 加载组织技能：${orgId} from ${skillsDirectory}`);
  
  // 示例返回
  return [];
}
