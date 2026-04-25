/**
 * OpenClaw 安全防护模块 — 记忆/文件访问控制
 * 
 * 位置: src/guard/memory-guard.ts
 * 作用: 控制用户对记忆/人设/技能文件的读写权限，防止间接注入
 */

// ===== 访问级别 =====

export enum AccessLevel {
  NONE = 0,      // 完全不可访问
  READ = 1,      // 只读
  WRITE = 2,     // 读写
}

export type Accessor = 'user' | 'agent' | 'admin';

// ===== 文件路径黑名单 =====

const FILE_BLACKLIST: { path: string; accessor: Accessor; maxLevel: AccessLevel }[] = [
  // 用户永远不能访问
  { path: '.workbuddy/memory/', accessor: 'user', maxLevel: AccessLevel.NONE },
  { path: '.workbuddy/skills/', accessor: 'user', maxLevel: AccessLevel.NONE },
  { path: '.workbuddy/automations/', accessor: 'user', maxLevel: AccessLevel.NONE },
  { path: 'SOUL.md', accessor: 'user', maxLevel: AccessLevel.NONE },
  { path: 'IDENTITY.md', accessor: 'user', maxLevel: AccessLevel.NONE },
  { path: 'USER.md', accessor: 'user', maxLevel: AccessLevel.NONE },
  { path: 'MEMORY.md', accessor: 'user', maxLevel: AccessLevel.NONE },
  { path: 'SKILL.md', accessor: 'user', maxLevel: AccessLevel.NONE },

  // Agent 可读写但受注入检测
  { path: '.workbuddy/memory/', accessor: 'agent', maxLevel: AccessLevel.WRITE },
  { path: '.workbuddy/skills/', accessor: 'agent', maxLevel: AccessLevel.READ },

  // 管理员完全访问
  { path: '.workbuddy/', accessor: 'admin', maxLevel: AccessLevel.WRITE },
];

// ===== 记忆写入注入检测 =====

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+previous/i,
  /忽略\s*之前/i,
  /you\s+are\s+now/i,
  /你\s*现在\s*是/i,
  /system\s*prompt/i,
  /系统\s*提示/i,
  /SOUL\.md/i,
  /MEMORY\.md/i,
  /SKILL\.md/i,
  /IDENTITY\.md/i,
  /USER\.md/i,
  /developer\s+mode/i,
  /开发者\s*模式/i,
  /jailbreak/i,
  /越狱/i,
  /disregard\s+your/i,
  /忽略\s*你的/i,
];

// ===== 主控制器 =====

export class MemoryGuard {
  /**
   * 检查文件访问权限
   */
  checkFileAccess(filePath: string, accessor: Accessor, requestedLevel: AccessLevel): {
    allowed: boolean;
    reason?: string;
  } {
    const normalized = filePath.replace(/\\/g, '/');

    for (const rule of FILE_BLACKLIST) {
      if (rule.accessor !== accessor) continue;

      if (normalized.includes(rule.path) || normalized.endsWith(rule.path)) {
        if (requestedLevel > rule.maxLevel) {
          return {
            allowed: false,
            reason: `访问被拒绝: ${rule.path} 对 ${accessor} 的最高权限为 ${AccessLevel[rule.maxLevel]}`,
          };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * 检测记忆写入内容中的注入攻击
   */
  validateWrite(content: string): {
    allowed: boolean;
    sanitized: string;
    detectedPatterns: string[];
  } {
    const detected: string[] = [];

    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(content)) {
        detected.push(pattern.source);
      }
    }

    if (detected.length > 0) {
      return { allowed: false, sanitized: '', detectedPatterns: detected };
    }

    // 脱敏
    let sanitized = content;
    sanitized = sanitized.replace(/\.workbuddy[^\s]*/g, '[PATH]');
    sanitized = sanitized.replace(/\/Users\/[\w]+\//g, '[HOME]/');
    sanitized = sanitized.replace(/\/home\/[\w]+\//g, '[HOME]/');

    return { allowed: true, sanitized, detectedPatterns: [] };
  }
}
