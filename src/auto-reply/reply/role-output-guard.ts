import type { ReplyPayload } from "../types.js";

const ROLE_INTRO_OVERRIDES: Record<string, string> = {
  "executive-manager":
    "你好，我是公司的职业经理人，负责向股东汇报，并协助拆解目标、分派任务、协调团队和汇总风险。",
  "operations-bot": "你好，我是运营 Bot，负责运营推进、任务跟踪、排期协调和阻塞同步。",
  "sales-bot": "你好，我是销售 Bot，负责客户需求澄清、商机推进和承诺边界把控。",
  "delivery-bot": "你好，我是交付 Bot，负责交付计划、进度、质量与风险闭环。",
  "knowledge-bot": "你好，我是知识与纪要 Bot，负责会议纪要、决策留痕、知识沉淀和 SOP 维护。",
  "toolsmith-bot": "你好，我是 toolsmith-bot，负责把工程需求整理成能力契约、技能草案和交接边界。",
  "coder-bot": "你好，我是 coder-bot，负责在既定契约和线程范围内完成工程实现、测试补充和交接说明。",
  "reviewer-bot":
    "你好，我是 reviewer-bot，负责审查实现与契约是否一致，并标记风险、验证缺口和复检要求。",
};

const ROLE_KEYWORDS: Record<string, string[]> = {
  "executive-manager": ["职业经理人", "经营层", "股东", "经营", "管理"],
  "operations-bot": ["运营", "排期", "推进", "协调"],
  "sales-bot": ["销售", "商机", "客户", "报价"],
  "delivery-bot": ["交付", "里程碑", "质量", "范围"],
  "knowledge-bot": ["知识", "纪要", "决策", "SOP"],
  "toolsmith-bot": ["toolsmith-bot", "能力契约", "技能草案", "交接边界", "guardrail"],
  "coder-bot": ["coder-bot", "工程实现", "实现", "测试", "交接"],
  "reviewer-bot": ["reviewer-bot", "审查", "评审", "风险", "复检", "契约"],
};

const ROLE_LEAK_MARKERS = [
  "opencode",
  "coding assistant",
  "software engineering",
  "software-engineering",
  "software engineer",
  "engineering consultant",
  "technical consultant",
  "智能软件工程顾问",
  "软件工程顾问",
  "技术顾问",
  "编程助手",
  "写代码",
  "改bug",
  "技术问题",
];

function isIdentityLikeReply(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.length > 220) {
    return false;
  }
  return (
    /^(?:hi|hello|hey)[!,. ]*(?:i\s*am|i['’]m|as\s+an?)\b/i.test(trimmed) ||
    /^(?:i\s*am|i['’]m|as\s+an?)\b/i.test(trimmed) ||
    /^(?:hi|hello|hey)[!,. ]*i\s+can\s+help\b/i.test(trimmed) ||
    /^i\s+can\s+help\b/i.test(trimmed) ||
    trimmed.startsWith("你好，我是") ||
    trimmed.startsWith("您好，我是") ||
    trimmed.startsWith("我是") ||
    trimmed.startsWith("我是一名") ||
    trimmed.startsWith("我叫") ||
    trimmed.startsWith("你好，我可以帮你") ||
    trimmed.startsWith("您好，我可以帮你") ||
    trimmed.startsWith("我可以帮你") ||
    trimmed.startsWith("可以帮你")
  );
}

function mentionsExpectedRole(text: string, agentId: string): boolean {
  const normalized = text.toLowerCase();
  const expectedKeywords = ROLE_KEYWORDS[agentId] ?? [];
  return expectedKeywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

function shouldOverrideRoleReply(text: string, agentId: string): boolean {
  if (!isIdentityLikeReply(text)) {
    return false;
  }
  const normalized = text.trim().toLowerCase();
  if (ROLE_LEAK_MARKERS.some((marker) => normalized.includes(marker))) {
    return true;
  }
  return !mentionsExpectedRole(text, agentId);
}

export function applyRoleReplyGuard(payload: ReplyPayload, agentId?: string): ReplyPayload {
  const normalizedAgentId = agentId?.trim().toLowerCase();
  if (!normalizedAgentId) {
    return payload;
  }
  const override = ROLE_INTRO_OVERRIDES[normalizedAgentId];
  const text = payload.text;
  if (!override || typeof text !== "string") {
    return payload;
  }
  if (!shouldOverrideRoleReply(text, normalizedAgentId)) {
    return payload;
  }
  return {
    ...payload,
    text: override,
  };
}
