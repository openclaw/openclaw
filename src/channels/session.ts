// 消息上下文类型，引用自动回复模板模块
import type { MsgContext } from "../auto-reply/templating.js";
// 分组密钥解析类型，引用配置会话模块
import type { GroupKeyResolution } from "../config/sessions/types.js";
// 字符串规范化工具函数
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
// 入站最后路由更新类型
import type { InboundLastRouteUpdate } from "./session.types.js";
// 导出入站最后路由更新和记录入站会话的类型
export type { InboundLastRouteUpdate, RecordInboundSession } from "./session.types.js";

// 延迟加载入站会话运行时模块的 Promise 缓存
let inboundSessionRuntimePromise: Promise<
  typeof import("../config/sessions/inbound.runtime.js")
> | null = null;

// 延迟加载入站会话运行时模块
function loadInboundSessionRuntime() {
  inboundSessionRuntimePromise ??= import("../config/sessions/inbound.runtime.js");
  return inboundSessionRuntimePromise;
}

// 判断是否应跳过固定主 DM 路由更新
// pin: 包含所有者接收者和发送者接收者的固定信息
function shouldSkipPinnedMainDmRouteUpdate(
  pin: InboundLastRouteUpdate["mainDmOwnerPin"] | undefined,
): boolean {
  // 如果没有固定信息，不跳过
  if (!pin) {
    return false;
  }
  // 规范化所有者接收者和发送者接收者
  const owner = normalizeLowercaseStringOrEmpty(pin.ownerRecipient);
  const sender = normalizeLowercaseStringOrEmpty(pin.senderRecipient);
  // 如果所有者或发送者为空，或所有者等于发送者，不跳过
  if (!owner || !sender || owner === sender) {
    return false;
  }
  // 执行跳过回调
  pin.onSkip?.({ ownerRecipient: pin.ownerRecipient, senderRecipient: pin.senderRecipient });
  return true;
}

// 记录入站会话的核心函数
// params: 包含存储路径、会话键、消息上下文、分组解析等参数
export async function recordInboundSession(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
  updateLastRoute?: InboundLastRouteUpdate;
  onRecordError: (err: unknown) => void;
}): Promise<void> {
  const { storePath, sessionKey, ctx, groupResolution, createIfMissing } = params;
  // 规范化会话键为小写
  const canonicalSessionKey = normalizeLowercaseStringOrEmpty(sessionKey);
  // 加载运行时模块
  const runtime = await loadInboundSessionRuntime();
  // 异步记录会话元数据，捕获错误但不阻塞
  void runtime
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: canonicalSessionKey,
      ctx,
      groupResolution,
      createIfMissing,
    })
    .catch(params.onRecordError);

  const update = params.updateLastRoute;
  // 如果没有路由更新，不处理
  if (!update) {
    return;
  }
  // 如果应跳过固定主 DM 路由更新，不处理
  if (shouldSkipPinnedMainDmRouteUpdate(update.mainDmOwnerPin)) {
    return;
  }
  // 规范化目标会话键
  const targetSessionKey = normalizeLowercaseStringOrEmpty(update.sessionKey);
  // 更新最后路由
  await runtime.updateLastRoute({
    storePath,
    sessionKey: targetSessionKey,
    deliveryContext: {
      channel: update.channel,
      to: update.to,
      accountId: update.accountId,
      threadId: update.threadId,
    },
    // 避免将入站来源元数据泄漏到不同的目标会话
    ctx: targetSessionKey === canonicalSessionKey ? ctx : undefined,
    groupResolution,
    createIfMissing,
  });
}
