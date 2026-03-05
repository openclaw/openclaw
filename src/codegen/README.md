# 代码生成系统 MVP

基于 OpenClaw 架构的多智能体代码生成系统 - 最小可行产品版本

## 🌐 Web 控制台入口（默认）

OpenGen 的默认 Web 入口已切换到 Next.js 控制台：

```bash
pnpm opengen:dev
```

默认地址：`http://127.0.0.1:3301`

说明：
- `scripts/start-web.sh` 现在会启动 Next.js 控制台。
- `src/codegen/server.ts` 保留为 legacy API 调试入口，不再作为默认运行路径。

## 📋 当前状态

**已实现的功能**：
- ✅ 核心类型定义
- ✅ 智能体基类（BaseAgent）
- ✅ PM Agent（产品经理智能体）
- ✅ Orchestrator（调度器）
- ✅ Anthropic LLM 客户端
- ✅ CLI 命令（generate）
- ✅ 测试脚本

**待实现的功能**：
- ⏳ Architect Agent（架构师智能体）
- ⏳ Coder Agent（编码智能体）
- ⏳ Reviewer Agent（审查智能体）
- ⏳ DevOps Agent（部署智能体）
- ⏳ 沙盒执行环境
- ⏳ 区块链确权

## 🚀 快速开始

### 1. 环境准备

```bash
# 设置 Anthropic API Key
export ANTHROPIC_API_KEY="your-api-key-here"

# 可选：设置模型和参数
export ANTHROPIC_MODEL="claude-3-5-sonnet-20241022"
export ANTHROPIC_MAX_TOKENS="4096"
export ANTHROPIC_TEMPERATURE="0.7"
```

### 2. 安装依赖

```bash
pnpm install
```

### 3. 运行测试

```bash
# 运行测试脚本（验证 PM Agent）
pnpm tsx src/codegen/test-runner.ts
```

### 4. 使用 CLI 命令

```bash
# 生成一个简单的 Todo 应用
pnpm tsx src/commands/generate.ts \
  --description "一个 Todo 应用，支持添加、删除、标记完成" \
  --type web \
  --tech-stack React TypeScript Node.js \
  --output result.json

# 生成博客平台
pnpm tsx src/commands/generate.ts \
  --description "个人博客平台，支持文章发布、评论、标签" \
  --type web \
  --tech-stack Next.js PostgreSQL \
  --timeline "2 weeks"

# 生成 REST API
pnpm tsx src/commands/generate.ts \
  --description "用户管理 API，包括注册、登录、权限控制" \
  --type api \
  --tech-stack Express PostgreSQL JWT
```

## 📁 项目结构

```
src/codegen/
├── types.ts              # 核心类型定义
├── base-agent.ts         # 智能体基类
├── llm-client.ts         # LLM 客户端（Anthropic）
├── orchestrator.ts       # 调度器
├── index.ts              # 模块入口
├── test-runner.ts        # 测试脚本
└── agents/
    └── pm-agent.ts       # PM Agent 实现

src/commands/
└── generate.ts           # CLI 命令
```

## 🧪 测试场景

测试脚本包含 3 个场景：

1. **Simple Todo App** - 简单的待办事项应用
2. **Blog Platform** - 个人博客平台
3. **REST API** - 用户管理 API

每个场景都会测试 PM Agent 的能力：
- 生成用户故事
- 列出功能清单
- 定义非功能性需求

## 📊 输出示例

```json
{
  "task_id": "task_1234567890_abc123",
  "status": "completed",
  "current_stage": "pm",
  "outputs": {
    "product_spec": {
      "user_stories": [
        {
          "as": "普通用户",
          "i_want": "能够添加新的待办事项",
          "so_that": "可以记录我需要完成的任务",
          "acceptance_criteria": [
            "用户可以输入任务标题",
            "任务自动保存到数据库",
            "添加成功后显示在列表中"
          ]
        }
      ],
      "features": [
        {
          "name": "任务管理",
          "priority": "high",
          "description": "添加、删除、编辑待办事项"
        }
      ],
      "non_functional_requirements": {
        "performance": "页面加载时间 < 2秒",
        "security": "用户数据加密存储",
        "scalability": "支持 1000+ 并发用户"
      }
    }
  },
  "created_at": 1234567890000,
  "completed_at": 1234567895000
}
```

## 🔧 开发指南

### 添加新的智能体

1. 在 `src/codegen/agents/` 创建新文件
2. 继承 `BaseAgent` 类
3. 实现 `execute()` 方法
4. 在 `orchestrator.ts` 中注册

示例：

```typescript
import { BaseAgent, type AgentContext } from '../base-agent.js';
import type { AgentConfig } from '../types.js';

export class MyAgent extends BaseAgent {
  constructor(config?: Partial<AgentConfig>) {
    super({
      role: 'my-role',
      model: 'claude-3-5-sonnet-20241022',
      temperature: 0.7,
      max_tokens: 4000,
      system_prompt: 'Your system prompt here',
      ...config,
    });
  }

  async execute(input: any, context: AgentContext): Promise<any> {
    // 实现你的逻辑
    const messages = this.buildMessages('Your prompt');
    const response = await this.callLLM(messages, context);
    return this.parseJSONResponse(response);
  }
}
```

### 扩展工作流

在 `orchestrator.ts` 中修改 `executeStage()` 方法：

```typescript
case 'my-stage':
  await this.executeMyStage(task, context);
  break;
```

## 🐛 调试

所有日志都以 JSON 格式输出到 stdout：

```json
{
  "timestamp": "2026-03-05T10:30:00.000Z",
  "component": "PMAgent",
  "level": "info",
  "message": "Starting PM analysis",
  "data": { "request_id": "req_123" }
}
```

可以使用 `jq` 过滤日志：

```bash
pnpm tsx src/codegen/test-runner.ts 2>&1 | jq 'select(.level == "error")'
```

## 📝 下一步计划

### 阶段 1.1：完成基础智能体（2周）
- [ ] 实现 Architect Agent
- [ ] 实现 Coder Agent（基础版）
- [ ] 实现 Reviewer Agent（基础版）

### 阶段 1.2：端到端流程（2周）
- [ ] 打通完整工作流（PM → Architect → Coder → Reviewer）
- [ ] 添加错误重试机制
- [ ] 实现简单的代码模板系统

### 阶段 1.3：沙盒执行（1周）
- [ ] Docker 容器隔离
- [ ] 代码编译和执行
- [ ] 安全限制

## 🤝 贡献指南

1. 创建功能分支：`git checkout -b feature/my-feature`
2. 提交代码：`git commit -m "Add my feature"`
3. 推送分支：`git push origin feature/my-feature`
4. 创建 Pull Request

## 📄 许可证

与 OpenClaw 保持一致

## 🔗 相关文档

- [系统架构蓝图](../docs/plans/2026-03-05-system-architecture.md)
- [实施路线图](../docs/plans/2026-03-05-multi-agent-coding-platform-roadmap.md)
- [OpenClaw 官方文档](https://docs.openclaw.ai)
