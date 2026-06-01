export type AicsConversationMode = "user" | "developer";

export type AicsConversationRole = "userExecutionAssistant" | "developerAssistant";

export type AicsConversationStage =
  | "ready"
  | "idle"
  | "intake"
  | "clarifying"
  | "briefGenerated"
  | "awaitingBusinessConfirmation"
  | "buildingPackage"
  | "validatingPackage"
  | "readyToUpload"
  | "submittedForReview";

export type AicsConversationProtocol = {
  mode: AicsConversationMode;
  role: AicsConversationRole;
  stage: AicsConversationStage;
  roleLabel: string;
  workIdentityLabel: string;
  stageLabel: string;
  stageDetail: string;
};

export const AICS_USER_ROLE_LABEL = "岗位使用与执行助手";
export const AICS_DEVELOPER_ROLE_LABEL = "岗位开发专属助手";

export const AICS_STAGE_LABELS: Record<AicsConversationStage, { label: string; detail: string }> = {
  ready: {
    label: "使用就绪",
    detail: "同一个聊天框下处理岗位使用、任务安排和执行结果。",
  },
  idle: {
    label: "开发待命",
    detail: "同一个聊天框下等待开发者只讲业务逻辑、使用对象和判断流程。",
  },
  intake: {
    label: "收集业务逻辑",
    detail: "同一个聊天框下收集岗位业务逻辑，尚不触发生成包或上传流程。",
  },
  clarifying: {
    label: "追问业务事实",
    detail: "只针对业务逻辑不清楚处追问，不要求开发者填写平台标准字段。",
  },
  briefGenerated: {
    label: "岗位规格已整理",
    detail: "平台已形成业务可读的岗位规格草案。",
  },
  awaitingBusinessConfirmation: {
    label: "等待业务确认",
    detail: "只确认业务理解是否正确，不要求确认输入、输出、规则或验收标准字段。",
  },
  buildingPackage: {
    label: "生成岗位包",
    detail: "平台正在用内置资料包生成 role_package/。",
  },
  validatingPackage: {
    label: "校验岗位包",
    detail: "正在扫描 token、key、后端 ID、本地路径和私有记忆泄漏。",
  },
  readyToUpload: {
    label: "可上传开发者中心",
    detail: "岗位包已通过本地校验，可交付开发者中心上传审核。",
  },
  submittedForReview: {
    label: "等待审核",
    detail: "岗位包已提交审核，等待开发者中心处理。",
  },
};

export const AICS_DEVELOPER_MODE_OPENING =
  "已进入开发者模式。当前角色：岗位开发专属助手；当前阶段：等待业务逻辑。你只需要讲清楚这个岗位要解决什么业务问题、给谁用、业务流程怎么判断、希望它完成什么结果。输入、输出、规则、验收标准、岗位包结构、协议和校验都由平台内置资料包自动处理；平台接口、授权、审计、计费和上传规则也会自动处理。";

export function getDefaultAicsConversationStage(mode: AicsConversationMode): AicsConversationStage {
  return mode === "developer" ? "idle" : "ready";
}

export function resolveAicsConversationProtocol(
  mode: AicsConversationMode,
  stage: AicsConversationStage = getDefaultAicsConversationStage(mode),
): AicsConversationProtocol {
  if (mode === "user") {
    const readyStage = AICS_STAGE_LABELS.ready;
    return {
      mode,
      role: "userExecutionAssistant",
      stage: "ready",
      roleLabel: AICS_USER_ROLE_LABEL,
      workIdentityLabel: "同一个聊天框下的岗位使用与任务执行身份",
      stageLabel: readyStage.label,
      stageDetail: readyStage.detail,
    };
  }

  const developerStage = stage === "ready" ? "idle" : stage;
  const stageCopy = AICS_STAGE_LABELS[developerStage] ?? AICS_STAGE_LABELS.idle;
  return {
    mode,
    role: "developerAssistant",
    stage: developerStage,
    roleLabel: AICS_DEVELOPER_ROLE_LABEL,
    workIdentityLabel: "同一个聊天框下的岗位开发工作身份",
    stageLabel: stageCopy.label,
    stageDetail: stageCopy.detail,
  };
}

export function advanceAicsDeveloperStageForBusinessLogic(
  stage: AicsConversationStage = "idle",
): AicsConversationStage {
  return stage === "idle" || stage === "ready" ? "intake" : stage;
}

export function buildAicsDeveloperModeApiText(
  message: string,
  stage: AicsConversationStage = "intake",
): string {
  const protocol = resolveAicsConversationProtocol("developer", stage);
  return [
    "[迭界AI开发者模式]",
    `当前角色：${protocol.roleLabel}`,
    `工作身份：${protocol.workIdentityLabel}`,
    `当前流程阶段：${protocol.stageLabel}。${protocol.stageDetail}`,
    "你是岗位开发专属助手。开发者只需要用自然语言讲业务逻辑，不需要填写输入、输出、规则、验收标准、平台接口、协议字段、授权字段、审计字段、计费字段或上传字段。",
    "输入、输出、规则、验收标准、岗位包结构、协议映射、验证材料和上传标准都是平台职责，已经内置在你的资料包里；不要让开发者定义、填写或逐项确认这些平台标准。",
    "如果业务逻辑不清楚，只用业务语言追问。不要暴露后端实现、执行 token、云端 bearer、授权编号、岗位 listing id、订单编号或结算归属字段。",
    "",
    "开发者消息:",
    message,
  ].join("\n");
}
