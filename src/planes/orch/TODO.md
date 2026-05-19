# OrchPlane — 待实现

**优先级**：Phase 1.3（Week 7-10）

## 文件清单

- [ ] `playbook-engine.ts` — Playbook 加载 + 触发 + 热重载
- [ ] `step-executor.ts` — 8种步骤类型（llm_reason/hitl/notify/action/subagent/skill/playbook/a2a_delegate）
- [ ] `hitl-gate.ts` — HITL 挂起/恢复（复用 api.runtime.tasks.managedFlows）
- [ ] `function-executor.ts` — 单次 LLM 推理
- [ ] `workorder-fsm.ts` — WorkOrder 状态机（迁移自 Python workorder_fsm.py）
- [ ] `alarm-fsm.ts` — Alarm 状态机（迁移自 Python alarm_fsm.py）
- [ ] `template.ts` — {{ expr }} 模板渲染（与 Python 格式兼容）
- [ ] `index.ts`

## 参考

- Python PlaybookEngine：`clawtwin-platform/platform-api/core/playbook_engine/executor.py` (876行)
- Python HITLResume：`clawtwin-platform/platform-api/core/playbook_engine/hitl_resume.py`
- Python FSM：`clawtwin-platform/platform-api/core/domain_logic/`
- OpenClaw 能力：`api.runtime.llm.complete()` / `api.runtime.tasks.managedFlows`
- 设计文档：`docs/design/MIGRATION-GUIDE.md` § PlaybookEngine / HITL FSM
