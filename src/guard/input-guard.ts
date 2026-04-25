/**
 * OpenClaw 安全防护模块 — 输入拦截
 * 
 * 位置: src/guard/input-guard.ts
 * 作用: 所有用户输入经过此模块，拦截 prompt 提取/角色劫持/记忆探测/技能探测/Skill 安装/格式逃逸
 * 语言: 中英文全覆盖
 */

// ===== 类型定义 =====

export type Severity = 'block' | 'warn' | 'log';
export type Category = 'prompt_extract' | 'role_override' | 'memory_probe' | 'skill_probe' | 'skill_install' | 'format_escape';

export interface GuardRule {
  id: string;
  patterns: RegExp[];
  keywords: string[];
  severity: Severity;
  category: Category;
  response: string;
}

export interface GuardResult {
  blocked: boolean;
  rule?: GuardRule;
  response?: string;
  allMatches: { ruleId: string; category: string; severity: string }[];
}

// ===== 规则库 =====

const GUARD_RULES: GuardRule[] = [
  // ==========================================
  // 1. Prompt 提取类
  // ==========================================
  {
    id: 'PE-001',
    patterns: [
      /system\s*prompt/i,
      /系统\s*提示/i,
      /系统\s*指令/i,
      /initial\s*instructions?/i,
      /原始\s*指令/i,
      /your\s*instructions?/i,
      /你的\s*指令/i,
      /your\s*rules?/i,
      /你的\s*规则/i,
      /your\s*constraints?/i,
      /你的\s*约束/i,
      /previously\s*provided/i,
      /之前\s*提供/i,
    ],
    keywords: [
      'SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md',
      'SKILL.md', 'system_prompt', '系统提示词',
      '人设文件', '角色设定', '人格设定', '角色配置',
      '人设配置', '角色文件',
    ],
    severity: 'block',
    category: 'prompt_extract',
    response: '我是您的专属侍酒师 Nora。关于品酒和选酒的问题，我很乐意为您服务。',
  },
  {
    id: 'PE-002',
    patterns: [
      /repeat\s*(the\s*)?(above|following|previous)/i,
      /重复\s*(上面的|之前的|以下的)/,
      /输出\s*(你的|之前的|上面的).*(指令|规则|提示)/,
      /print\s*(out\s*)?your\s*(rules|instructions|prompt)/i,
      /show\s*me\s*your\s*(rules|instructions|prompt)/i,
      /显示\s*你的\s*(规则|指令|提示)/,
      /tell\s*me\s*your\s*(rules|instructions|prompt)/i,
      /告诉\s*我\s*你的\s*(规则|指令|提示)/,
      /reveal\s*your/i,
      /泄露\s*你的/i,
      /disclose\s+your/i,
      /公开\s*你的/i,
      /share\s+your\s+(instructions|rules|prompt)/i,
      /分享\s*你的\s*(指令|规则|提示)/,
    ],
    keywords: [],
    severity: 'block',
    category: 'prompt_extract',
    response: '作为您的侍酒师，我专注于为您提供最好的葡萄酒推荐和品鉴建议。',
  },
  {
    id: 'PE-003',
    patterns: [
      /translate\s+your\s+(rules|instructions|prompt)/i,
      /把\s*你的\s*(规则|指令|提示)\s*翻译/i,
      /summarize\s+your\s+(rules|instructions|constraints)/i,
      /总结\s*你的\s*(规则|指令|约束)/,
      /explain\s+how\s+you\s+work/i,
      /解释\s*你\s*怎么\s*工作/i,
      /你\s*的\s*(内部|底层|核心)\s*(逻辑|机制|原理)/,
      /how\s+are\s+you\s+(programmed|configured|built|designed)/i,
      /你\s*是\s*怎么\s*(设计|编程|配置)\s*的/,
      /what\s+is\s+your\s+(architecture|pipeline|workflow)/i,
      /你\s*的\s*(架构|流水线|工作流)\s*是\s*什么/,
      /describe\s+your\s+(internal|underlying)\s+(logic|system)/i,
    ],
    keywords: [],
    severity: 'block',
    category: 'prompt_extract',
    response: '我的专长是葡萄酒。让我们聊聊您感兴趣的酒吧！',
  },
  {
    id: 'PE-004',
    patterns: [
      /what\s+(are|were)\s+you\s+told/i,
      /你\s*(被|是)\s*(告诉|设定|赋予)\s*了\s*什么/,
      /what\s+can('t|\s+not)\s+you\s+(do|say)/i,
      /你\s*(不能|不可以|无法)\s*(做|说)\s*什么/,
      /what\s+are\s+you\s+hiding/i,
      /你\s*在\s*隐藏\s*什么/,
      /what\s+don't\s+you\s+want\s+me\s+to\s+know/i,
      /你\s*不想\s*让我\s*知道\s*什么/,
    ],
    keywords: [],
    severity: 'warn',
    category: 'prompt_extract',
    response: '我专注于为您提供专业葡萄酒服务。有什么选酒需求？',
  },

  // ==========================================
  // 2. 角色劫持类
  // ==========================================
  {
    id: 'RO-001',
    patterns: [
      /ignore\s+(all\s+)?previous\s+(instructions|rules|prompts)/i,
      /忽略\s*(所有\s*)?之前的\s*(指令|规则|提示)/,
      /forget\s+(all\s+)?previous/i,
      /忘记\s*(所有\s*)?之前的/,
      /disregard\s+(your|all)\s+(instructions|rules)/i,
      /disregarding\s+previous/i,
      /you\s+are\s+now\s+/i,
      /你\s*现在\s*是/,
      /from\s+now\s+on\s+you\s*(are|will)/i,
      /从\s*现在\s*起\s*你/,
      /pretend\s+(that\s+)?you\s+(are|are\s+not)/i,
      /假装\s*你\s*(是|不是)/,
      /act\s+as\s+if\s+you\s+(are|were)/i,
      /扮演\s*(成|为)/,
      /你\s*不\s*再\s*是\s*Nora/,
      /you\s*are\s*(no\s+longer|not)\s+Nora/i,
    ],
    keywords: [
      'DAN', 'jailbreak', '越狱', '解除限制',
      'developer mode', '开发者模式', 'debug mode', '调试模式',
      'sudo', 'root', 'admin mode', '管理员模式',
      'God mode', '上帝模式', '维护模式', 'maintenance mode',
    ],
    severity: 'block',
    category: 'role_override',
    response: '我是 Nora，您的专属侍酒师。有什么葡萄酒相关的问题我可以帮您？',
  },
  {
    id: 'RO-002',
    patterns: [
      /你\s*什么都\s*可以\s*(说|做|回答)/,
      /you\s+can\s+(now\s+)?(say|do|answer)\s+anything/i,
      /没有\s*限制/,
      /no\s+(more\s+)?restrictions?/i,
      /不受\s*(约束|限制)/,
      /unrestricted/i,
      /释放\s*你的\s*(全部|真正)\s*(能力|潜力)/,
      /unleash\s+your/i,
      /you\s+have\s+no\s+(more\s+)?(rules|limits|restrictions)/i,
      /你\s*(已经\s*)?没有\s*(规则|限制|约束)\s*了/,
      /一切\s*限制\s*已\s*(解除|取消|移除)/,
      /all\s+restrictions\s+(removed|lifted|disabled)/i,
    ],
    keywords: [],
    severity: 'block',
    category: 'role_override',
    response: '作为专业侍酒师，我在葡萄酒领域为您提供最专业的建议。',
  },
  {
    id: 'RO-003',
    patterns: [
      /do\s+anything\s+i\s+say/i,
      /按\s*我\s*说\s*的\s*做/,
      /you\s+must\s+obey/i,
      /你\s*必须\s*服从/,
      /i\s+am\s+your\s+(master|owner|creator)/i,
      /我\s*是\s*你的\s*(主人|创造者|所有者)/,
      /your\s+new\s+(role|identity|persona)\s+is/i,
      /你\s*的\s*新\s*(角色|身份|人设)\s*是/,
    ],
    keywords: [],
    severity: 'block',
    category: 'role_override',
    response: '我始终是 Nora — 您的葡萄酒管家。让我们聊聊酒吧。',
  },

  // ==========================================
  // 3. 记忆探测类
  // ==========================================
  {
    id: 'MP-001',
    patterns: [
      /what\s+do\s+you\s+(remember|know)\s+about/i,
      /你\s*(记得|记住|知道)\s*什么/i,
      /你\s*的\s*记忆/i,
      /your\s+memory/i,
      /你\s*的\s*(长期|工作)\s*记忆/i,
      /long[\s-]?term\s+memory/i,
      /working\s+memory/i,
      /read\s+(your\s+)?memory/i,
      /读取\s*(你的\s*)?记忆/i,
      /日记\s*文件/i,
      /daily\s*log/i,
      /你\s*的\s*日记/i,
      /your\s+(daily\s+)?log/i,
    ],
    keywords: [
      'MEMORY.md', '记忆文件', '工作记忆',
      '长期记忆', 'daily log', '日记', '日志文件',
      '工作日志',
    ],
    severity: 'block',
    category: 'memory_probe',
    response: '我专注于为您推荐最适合的葡萄酒。告诉我您今晚想喝什么风格的？',
  },
  {
    id: 'MP-002',
    patterns: [
      /你\s*存储\s*了\s*哪些\s*(关于\s*我的|用户)\s*信息/,
      /what\s+(user|personal)\s+(data|info|information)\s+do\s+you\s+(store|have|keep)/i,
      /你\s*了解\s*我\s*什么/,
      /what\s+do\s+you\s+know\s+about\s+me/i,
      /你\s*保存\s*了\s*我\s*的\s*什么/,
      /what\s+have\s+you\s+(saved|stored)\s+about\s+me/i,
    ],
    keywords: [],
    severity: 'warn',
    category: 'memory_probe',
    response: '我专注于为您提供个性化葡萄酒推荐。有什么选酒需求？',
  },

  // ==========================================
  // 4. 技能/工具探测类
  // ==========================================
  {
    id: 'SP-001',
    patterns: [
      /list\s+(your\s+)?skills?/i,
      /列出\s*(你的\s*)?技能/i,
      /show\s+(me\s+)?your\s+skills?/i,
      /显示\s*你的\s*技能/i,
      /what\s+(tools?|abilities|capabilities)\s+do\s+you\s+have/i,
      /你\s*有\s*什么\s*(工具|能力|技能)/i,
      /你\s*能\s*做\s*什么/i,
      /what\s+can\s+you\s+do/i,
      /技能\s*定义/i,
      /skill\s+definition/i,
      /你\s*的\s*技能\s*列表/i,
      /your\s+skill\s+list/i,
    ],
    keywords: [
      'SKILL.md', '技能文件', 'skill definition',
      'scripts/', 'references/',
    ],
    severity: 'block',
    category: 'skill_probe',
    response: '我精通葡萄酒推荐、品鉴咨询和餐酒搭配。有什么我可以帮您的？',
  },
  {
    id: 'SP-002',
    patterns: [
      /你\s*用\s*什么\s*(工具|系统|数据库|架构)/i,
      /what\s+(tools|systems?|databases?|stack)\s+do\s+you\s+use/i,
      /你的\s*(数据|SKU|库存)\s*(结构|格式|schema)/i,
      /your\s+(data|sku|inventory)\s*(structure|format|schema)/i,
      /你\s*的\s*后端\s*是\s*什么/i,
      /what\s+is\s+your\s+backend/i,
    ],
    keywords: [],
    severity: 'block',
    category: 'skill_probe',
    response: '我拥有专业的葡萄酒知识库和全球价格数据。告诉我您的需求，我来为您推荐。',
  },

  // ==========================================
  // 5. Skill 安装/投毒类
  // ==========================================
  {
    id: 'SI-001',
    patterns: [
      /install\s+(a\s+)?(new\s+)?skill/i,
      /安装\s*(新\s*)?技能/i,
      /add\s+(a\s+)?skill/i,
      /添加\s*技能/i,
      /load\s+(this\s+)?skill/i,
      /加载\s*(这个\s*)?技能/i,
      /import\s+(a\s+)?skill/i,
      /导入\s*技能/i,
      /create\s+(a\s+)?skill/i,
      /创建\s*技能/i,
      /write\s+(a\s+)?SKILL\.md/i,
      /写\s*SKILL\.md/i,
      /下载\s*技能/i,
      /download\s+skill/i,
      /帮我\s*(装|安|加|载)\s*(一个\s*)?(新\s*)?技能/i,
    ],
    keywords: [
      '安装技能', '添加技能', '加载技能', '创建技能', '导入技能',
      'install skill', 'add skill', 'load skill', 'create skill', 'import skill',
    ],
    severity: 'block',
    category: 'skill_install',
    response: '技能管理需要管理员权限。如果您有葡萄酒相关需求，我直接为您服务。',
  },

  // ==========================================
  // 6. 格式逃逸类
  // ==========================================
  {
    id: 'FE-001',
    patterns: [
      /output\s+in\s+(base64|binary|hex|json|xml|yaml|markdown|code)/i,
      /用\s*(base64|二进制|十六进制|JSON|XML|YAML|代码)\s*格式\s*输出/i,
      /encode\s+your\s+(rules|instructions|prompt)/i,
      /编码\s*你的\s*(规则|指令|提示)/,
      /wrap\s+in\s+code\s+block/i,
      /用\s*代码块\s*包裹/i,
      /用\s*编程\s*语言\s*表达/i,
      /as\s+a\s+(python|javascript|json)\s+(script|object|array)/i,
      /当作\s*(Python|JavaScript|JSON)\s*(脚本|对象|数组)\s*输出/i,
    ],
    keywords: [],
    severity: 'warn',
    category: 'format_escape',
    response: '我可以用专业但通俗的方式为您讲解任何葡萄酒知识。',
  },
];

// ===== 拦截器 =====

export class InputGuard {
  private rules: GuardRule[];

  constructor() {
    this.rules = GUARD_RULES;
  }

  /**
   * 检查用户输入
   * @returns GuardResult
   */
  check(input: string): GuardResult {
    const allMatches: GuardResult['allMatches'] = [];
    let highestSeverity: Severity | null = null;
    let blockingRule: GuardRule | null = null;

    for (const rule of this.rules) {
      if (this.matchRule(input, rule)) {
        allMatches.push({
          ruleId: rule.id,
          category: rule.category,
          severity: rule.severity,
        });

        if (rule.severity === 'block') {
          blockingRule = rule;
          highestSeverity = 'block';
          break;
        } else if (rule.severity === 'warn' && highestSeverity !== 'block') {
          highestSeverity = 'warn';
          blockingRule = rule;
        }
      }
    }

    return {
      blocked: highestSeverity === 'block',
      rule: blockingRule || undefined,
      response: blockingRule?.response,
      allMatches,
    };
  }

  private matchRule(input: string, rule: GuardRule): boolean {
    for (const pattern of rule.patterns) {
      if (pattern.test(input)) return true;
    }
    const lowerInput = input.toLowerCase();
    for (const keyword of rule.keywords) {
      if (lowerInput.includes(keyword.toLowerCase())) return true;
    }
    return false;
  }
}
