/**
 * OpenClaw 安全防护模块 — Skill 安装审计
 * 
 * 位置: src/guard/skill-audit.ts
 * 作用: 扫描待安装 Skill 的 SKILL.md 和 scripts，检测恶意指令
 */

// ===== 类型 =====

type RiskLevel = 'P0' | 'P1' | 'P2';

interface Risk {
  level: RiskLevel;
  description: string;
  file: string;
}

interface AuditResult {
  safe: boolean;
  risks: Risk[];
  summary: string;
}

// ===== 危险模式库 =====

const SKILLMD_DANGEROUS: { pattern: RegExp; level: RiskLevel; desc: string }[] = [
  // P0: 直接攻击
  { pattern: /ignore\s+(all\s+)?previous/i, level: 'P0', desc: 'SKILL.md: 试图覆盖指令' },
  { pattern: /忽略\s*之前的/i, level: 'P0', desc: 'SKILL.md: 试图覆盖指令' },
  { pattern: /read.*MEMORY\.md/i, level: 'P0', desc: 'SKILL.md: 试图读取记忆文件' },
  { pattern: /读取.*记忆/i, level: 'P0', desc: 'SKILL.md: 试图读取记忆文件' },
  { pattern: /read.*SOUL\.md/i, level: 'P0', desc: 'SKILL.md: 试图读取人设文件' },
  { pattern: /sudo|chmod\s+777|rm\s+-rf/i, level: 'P0', desc: 'SKILL.md: 危险系统命令' },
  { pattern: /you\s+are\s+now/i, level: 'P0', desc: 'SKILL.md: 试图劫持角色' },
  { pattern: /你\s*现在\s*是/i, level: 'P0', desc: 'SKILL.md: 试图劫持角色' },
  { pattern: /output\s+your\s+(rules|instructions|prompt)/i, level: 'P0', desc: 'SKILL.md: 试图提取 prompt' },
  { pattern: /输出\s*你的\s*(规则|指令|提示)/i, level: 'P0', desc: 'SKILL.md: 试图提取 prompt' },

  // P1: 可疑操作
  { pattern: /\.workbuddy/i, level: 'P1', desc: 'SKILL.md: 访问内部目录' },
  { pattern: /process\.env/i, level: 'P1', desc: 'SKILL.md: 读取环境变量' },
  { pattern: /fetch\s*\(/i, level: 'P1', desc: 'SKILL.md: 发起网络请求' },
  { pattern: /axios/i, level: 'P1', desc: 'SKILL.md: 使用 axios 请求' },
  { pattern: /writeFile|writeFileSync/i, level: 'P1', desc: 'SKILL.md: 文件写入操作' },
];

const SCRIPT_DANGEROUS: { pattern: RegExp; level: RiskLevel; desc: string }[] = [
  // P0: 严重风险
  { pattern: /exec\s*\(/, level: 'P0', desc: '任意命令执行 (exec)' },
  { pattern: /execSync\s*\(/, level: 'P0', desc: '同步命令执行 (execSync)' },
  { pattern: /child_process/, level: 'P0', desc: '子进程调用' },
  { pattern: /eval\s*\(/, level: 'P0', desc: 'eval 动态执行' },
  { pattern: /Function\s*\(/, level: 'P0', desc: '动态函数构造' },
  { pattern: /\/etc\/passwd/, level: 'P0', desc: '读取系统密码文件' },
  { pattern: /rm\s+-rf\s+\//, level: 'P0', desc: '递归删除根目录' },
  { pattern: /mkfs/, level: 'P0', desc: '磁盘格式化' },
  { pattern: /nc\s+-l/, level: 'P0', desc: '反弹 shell (netcat)' },
  { pattern: /curl.*\|.*sh/, level: 'P0', desc: '管道执行远程脚本' },
  { pattern: /wget.*\|.*sh/, level: 'P0', desc: '管道执行远程脚本' },

  // P1: 高风险
  { pattern: /\.workbuddy/, level: 'P1', desc: '访问 .workbuddy 目录' },
  { pattern: /process\.env/, level: 'P1', desc: '读取环境变量' },
  { pattern: /fetch\s*\(\s*['"`]https?:\/\//, level: 'P1', desc: 'HTTP 外部请求' },
  { pattern: /axios\.(get|post)/, level: 'P1', desc: 'Axios 外部请求' },
  { pattern: /XMLHttpRequest/, level: 'P1', desc: 'XHR 外部请求' },
  { pattern: /require\s*\(\s*['"]net['"]\s*\)/, level: 'P1', desc: '引入 net 模块 (可能建服务器)' },
  { pattern: /require\s*\(\s*['"]fs['"]\s*\)/, level: 'P1', desc: '引入 fs 模块' },

  // P2: 低风险但需注意
  { pattern: /writeFile|writeFileSync/, level: 'P2', desc: '文件写入操作' },
  { pattern: /fs\.append/, level: 'P2', desc: '文件追加操作' },
  { pattern: /setTimeout|setInterval/, level: 'P2', desc: '定时器 (可能长期驻留)' },
];

// ===== 审计器 =====

export class SkillAuditor {
  /**
   * 审计一个待安装的 Skill
   * @param skillMd SKILL.md 内容
   * @param scripts 脚本文件内容数组 [{filename, content}]
   */
  audit(skillMd: string, scripts: { filename: string; content: string }[]): AuditResult {
    const risks: Risk[] = [];

    // 审计 SKILL.md
    for (const check of SKILLMD_DANGEROUS) {
      if (check.pattern.test(skillMd)) {
        risks.push({ level: check.level, description: check.desc, file: 'SKILL.md' });
      }
    }

    // 审计每个脚本
    for (const script of scripts) {
      for (const check of SCRIPT_DANGEROUS) {
        if (check.pattern.test(script.content)) {
          risks.push({ level: check.level, description: check.desc, file: script.filename });
        }
      }
    }

    const hasP0 = risks.some(r => r.level === 'P0');
    const hasP1 = risks.some(r => r.level === 'P1');
    const p0Count = risks.filter(r => r.level === 'P0').length;
    const p1Count = risks.filter(r => r.level === 'P1').length;
    const p2Count = risks.filter(r => r.level === 'P2').length;

    let summary: string;
    if (hasP0) {
      summary = `❌ 拒绝安装: 发现 ${p0Count} 个严重风险`;
    } else if (hasP1) {
      summary = `⚠️ 需管理员审批: 发现 ${p1Count} 个高风险 + ${p2Count} 个低风险`;
    } else {
      summary = `✅ 安全: 仅 ${p2Count} 个低风险`;
    }

    return {
      safe: !hasP0,
      risks,
      summary,
    };
  }
}
