# A2A Server — 待实现

**优先级**：Phase 2.2（Week 13-15）

## 文件清单

- [ ] `agent-card.ts` — GET /.well-known/agent.json（A2A Agent Card）
- [ ] `task-handler.ts` — POST /a2a/tasks（接收外部 A2A Task → 内部 Event）
- [ ] `client.ts` — 主动发起 A2A 请求（用于 Playbook a2a_delegate 步骤）
- [ ] `index.ts`

## 挂载方式

```typescript
// extensions/claworks-robot/index.ts
api.registerHttpRoute({ method: "GET", path: "/.well-known/agent.json", handler: agentCard });
api.registerHttpRoute({ method: "POST", path: "/a2a/tasks", handler: taskHandler });
```

## 参考

- Google A2A 规范：https://google.github.io/A2A/
- OpenClaw 已有内部 A2A：`src/agents/tools/sessions-send-tool.a2a.ts`
- 设计文档：`docs/design/ARCHITECTURE.md` § 多机器人 A2A 网格
