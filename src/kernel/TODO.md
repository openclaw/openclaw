# EventKernel — 待实现

**优先级**：Phase 1.2（Week 5-7）

## 文件清单

- [ ] `event-bus.ts` — EventBus，优先级队列（CRITICAL/HIGH/NORMAL/LOW）
- [ ] `matcher.ts` — 事件→Playbook 匹配（精确 / 通配符 / 语义 fallback）
- [ ] `scheduler.ts` — Cron 定时触发（复用 OpenClaw gateway cron hooks）
- [ ] `outbox.ts` — 可靠投递（持久化，至少一次）
- [ ] `index.ts` — EventKernel 主类，start/stop/publish/subscribe

## 参考

- Python 原版：`clawtwin-platform/platform-api/core/event_router/` (402行)
- 挂载方式：`extensions/claworks-robot/index.ts` → `api.registerService()`
- 设计文档：`docs/design/MIGRATION-GUIDE.md` § EventRouter → EventKernel
